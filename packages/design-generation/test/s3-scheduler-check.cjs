"use strict";

const assert = require('node:assert/strict');
const { runDagScheduler, DagSchedulerError } = require('../dist/dag-scheduler.js');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function task(taskId, order, dependencies = []) {
  return { taskId, order, dependencies, input: taskId };
}

async function expectSchedulerError(tasks, code, maxParallel = 1) {
  await assert.rejects(
    runDagScheduler({ tasks, maxParallel, worker: async (item) => item.input }),
    (error) => error instanceof DagSchedulerError && error.code === code,
    `Expected DAG validation error ${code}`
  );
}

async function testDagValidation() {
  await expectSchedulerError([task('a', 0, ['b']), task('b', 1, ['a'])], 'DEPENDENCY_CYCLE');
  await expectSchedulerError([task('a', 0, ['missing'])], 'UNKNOWN_DEPENDENCY');
  await expectSchedulerError([task('a', 0), task('a', 1)], 'DUPLICATE_TASK_ID');
  await expectSchedulerError([task('a', 0, ['a'])], 'SELF_DEPENDENCY');
  await expectSchedulerError([task('a', 0)], 'INVALID_MAX_PARALLEL', 2);
}

async function testConcurrencyAndStableOutput() {
  for (const maxParallel of [1, 3, 5]) {
    const tasks = Array.from({ length: 13 }, (_, index) => task(`region_${String(index).padStart(2, '0')}`, index));
    const runs = [];
    for (let repetition = 0; repetition < 5; repetition++) {
      let active = 0;
      let observedMax = 0;
      const result = await runDagScheduler({
        tasks,
        maxParallel,
        runId: `run_${maxParallel}_${repetition}`,
        attemptId: `attempt_${maxParallel}_${repetition}`,
        worker: async (item) => {
          active++;
          observedMax = Math.max(observedMax, active);
          // A deterministic pseudo-random delay deliberately reorders completions.
          const value = Number(item.taskId.slice(-2));
          await pause((value * 17 + repetition * 11) % 19);
          active--;
          return `result:${item.taskId}`;
        }
      });
      assert.equal(result.state, 'completed');
      assert.ok(result.maxObservedParallel <= maxParallel, `scheduler exceeded maxParallel=${maxParallel}`);
      assert.ok(result.maxObservedParallel >= Math.min(maxParallel, tasks.length));
      assert.ok(observedMax <= maxParallel, `worker observed concurrency above ${maxParallel}`);
      assert.deepEqual(result.tasks.map((entry) => entry.task.taskId), tasks.map((entry) => entry.taskId));
      assert.deepEqual(result.tasks.map((entry) => entry.result), tasks.map((entry) => `result:${entry.taskId}`));
      runs.push(result.tasks.map((entry) => entry.task.taskId));
    }
    for (const run of runs) assert.deepEqual(run, tasks.map((entry) => entry.taskId), 'result order must be stable despite randomized completion order');
  }
}

async function testStableTopologicalOrderAndDependencyResults() {
  const startOrder = [];
  const result = await runDagScheduler({
    tasks: [
      task('d', 3, ['b', 'c']),
      task('c', 2, ['a']),
      task('b', 1, ['a']),
      task('a', 0)
    ],
    maxParallel: 3,
    worker: async (item, context) => {
      startOrder.push(item.taskId);
      if (item.taskId === 'd') {
        assert.equal(context.dependencyResults.get('b'), 'B');
        assert.equal(context.dependencyResults.get('c'), 'C');
      }
      await pause(item.taskId === 'b' ? 8 : 1);
      return item.taskId.toUpperCase();
    }
  });
  assert.deepEqual(startOrder, ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.tasks.map((entry) => entry.task.taskId), ['a', 'b', 'c', 'd']);
  assert.equal(result.tasks.every((entry) => entry.state === 'completed'), true);
}

async function testFailureBlocksOnlyDependents() {
  const events = [];
  const result = await runDagScheduler({
    tasks: [task('failed', 0), task('dependent', 1, ['failed']), task('transitive', 2, ['dependent']), task('independent', 3)],
    maxParallel: 3,
    onTaskEvent: (event) => events.push(event),
    worker: async (item) => {
      if (item.taskId === 'failed') throw Object.assign(new Error('provider unavailable'), { code: 'MODEL_DOWN', retryable: true });
      return `${item.taskId}:ok`;
    }
  });
  const byId = new Map(result.tasks.map((entry) => [entry.task.taskId, entry]));
  assert.equal(result.state, 'partial');
  assert.equal(byId.get('failed').state, 'failed');
  assert.equal(byId.get('failed').error.code, 'MODEL_DOWN');
  assert.equal(byId.get('failed').error.retryable, true);
  assert.equal(byId.get('dependent').state, 'blocked');
  assert.equal(byId.get('transitive').state, 'blocked');
  assert.equal(byId.get('independent').state, 'completed');
  assert.equal(events.filter((event) => event.taskId === 'dependent' && event.state === 'running').length, 0);
  assert.equal(events.filter((event) => event.taskId === 'independent' && event.state === 'completed').length, 1);
}

async function testCancellationFencesLateCompletion() {
  const controller = new AbortController();
  const events = [];
  let finishWorker;
  let workerContext;
  const runPromise = runDagScheduler({
    tasks: [task('active', 0), task('queued', 1)],
    maxParallel: 1,
    runId: 'cancel_run',
    attemptId: 'cancel_attempt',
    signal: controller.signal,
    onTaskEvent: (event) => events.push(event),
    worker: (_item, context) => {
      workerContext = context;
      return new Promise((complete) => { finishWorker = complete; });
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workerContext.isCurrent(), true);
  const activeLease = events.find((event) => event.taskId === 'active' && event.state === 'running')?.leaseId;
  assert.ok(activeLease, 'running task should receive a lease ID');

  controller.abort();
  const cancelled = await runPromise;
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(cancelled.tasks.map((entry) => entry.state), ['cancelled', 'cancelled']);
  assert.equal(workerContext.isCurrent(), false, 'cancelled lease must be fenced immediately');

  finishWorker('late result');
  await pause(0);
  assert.equal(cancelled.tasks.some((entry) => entry.result === 'late result'), false);
  assert.equal(events.some((event) => event.taskId === 'active' && event.state === 'completed'), false, 'late completion must not emit a completion event');
}

async function main() {
  await testDagValidation();
  await testConcurrencyAndStableOutput();
  await testStableTopologicalOrderAndDependencyResults();
  await testFailureBlocksOnlyDependents();
  await testCancellationFencesLateCompletion();
  console.log('design-generation S3 scheduler self-check passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

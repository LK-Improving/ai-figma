import { randomUUID } from 'node:crypto';
import type { AgentTask } from '@miaoma/shared-protocol';

export type DagTaskState = AgentTask['state'];
export type DagTaskTerminalState = Extract<DagTaskState, 'completed' | 'failed' | 'blocked' | 'cancelled'>;

/** A task ID is the stable region ID used by the DesignPlan dependency edges. */
export interface DagTask<Input> {
  taskId: string;
  order: number;
  dependencies?: readonly string[];
  input: Input;
}

export interface DagTaskError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DagTaskEvent {
  runId: string;
  attemptId: string;
  taskId: string;
  leaseId?: string;
  state: DagTaskState;
  error?: DagTaskError;
}

export interface DagTaskContext<Result> {
  runId: string;
  attemptId: string;
  leaseId: string;
  signal?: AbortSignal;
  /** Use before producing externally visible results; false means this lease was fenced. */
  isCurrent(): boolean;
  /** Contains only successful dependency results. */
  dependencyResults: ReadonlyMap<string, Result>;
}

export interface DagTaskResult<Input, Result> {
  task: DagTask<Input>;
  state: DagTaskTerminalState;
  leaseId?: string;
  result?: Result;
  error?: DagTaskError;
}

export interface DagSchedulerResult<Input, Result> {
  runId: string;
  attemptId: string;
  state: 'completed' | 'partial' | 'cancelled';
  maxObservedParallel: number;
  tasks: readonly DagTaskResult<Input, Result>[];
}

export interface RunDagOptions<Input, Result> {
  tasks: readonly DagTask<Input>[];
  maxParallel: 1 | 3 | 5;
  runId?: string;
  attemptId?: string;
  signal?: AbortSignal;
  worker(task: DagTask<Input>, context: DagTaskContext<Result>): Promise<Result> | Result;
  onTaskEvent?(event: DagTaskEvent): void;
  /** Injectable for deterministic tests and callers that own lease IDs. */
  leaseIdFactory?(taskId: string, attemptId: string, ordinal: number): string;
}

export type DagSchedulerErrorCode =
  | 'INVALID_MAX_PARALLEL'
  | 'INVALID_TASK'
  | 'DUPLICATE_TASK_ID'
  | 'DUPLICATE_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'SELF_DEPENDENCY'
  | 'DEPENDENCY_CYCLE';

export class DagSchedulerError extends Error {
  constructor(readonly code: DagSchedulerErrorCode, message: string, readonly taskId?: string) {
    super(message);
    this.name = 'DagSchedulerError';
  }
}

type NormalizedTask<Input> = DagTask<Input> & { dependencies: readonly string[]; input: Input; inputIndex: number };
type MutableResult<Input, Result> = {
  task: NormalizedTask<Input>;
  state: DagTaskState;
  leaseId?: string;
  result?: Result;
  error?: DagTaskError;
};

const TERMINAL = new Set<DagTaskState>(['completed', 'failed', 'blocked', 'cancelled', 'stale']);

function compareTask<Input>(left: NormalizedTask<Input>, right: NormalizedTask<Input>): number {
  if (left.order !== right.order) return left.order - right.order;
  if (left.taskId < right.taskId) return -1;
  if (left.taskId > right.taskId) return 1;
  return left.inputIndex - right.inputIndex;
}

function normalizeAndSort<Input>(tasks: readonly DagTask<Input>[]): NormalizedTask<Input>[] {
  if (!Array.isArray(tasks)) throw new DagSchedulerError('INVALID_TASK', 'DAG tasks must be an array');
  const byId = new Map<string, NormalizedTask<Input>>();
  tasks.forEach((task, inputIndex) => {
    if (!task || typeof task !== 'object' || typeof task.taskId !== 'string' || !task.taskId.trim()
      || !Number.isSafeInteger(task.order) || task.order < 0 || !Array.isArray(task.dependencies ?? [])) {
      throw new DagSchedulerError('INVALID_TASK', `Task at index ${inputIndex} must have a non-empty ID, non-negative integer order, and dependency array`);
    }
    const taskId = task.taskId.trim();
    if (byId.has(taskId)) throw new DagSchedulerError('DUPLICATE_TASK_ID', `DAG contains duplicate task ID ${taskId}`, taskId);
    const dependencies = [...(task.dependencies ?? [])];
    if (dependencies.some((dependency) => typeof dependency !== 'string' || !dependency.trim())) {
      throw new DagSchedulerError('INVALID_TASK', `Task ${taskId} contains an invalid dependency ID`, taskId);
    }
    const unique = new Set<string>();
    for (const dependency of dependencies) {
      if (unique.has(dependency)) throw new DagSchedulerError('DUPLICATE_DEPENDENCY', `Task ${taskId} lists dependency ${dependency} more than once`, taskId);
      unique.add(dependency);
      if (dependency === taskId) throw new DagSchedulerError('SELF_DEPENDENCY', `Task ${taskId} cannot depend on itself`, taskId);
    }
    byId.set(taskId, { taskId, order: task.order, dependencies, input: task.input, inputIndex });
  });

  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const [taskId, task] of byId) {
    indegree.set(taskId, task.dependencies.length);
    successors.set(taskId, []);
  }
  for (const [taskId, task] of byId) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) throw new DagSchedulerError('UNKNOWN_DEPENDENCY', `Task ${taskId} depends on unknown task ${dependency}`, taskId);
      successors.get(dependency)!.push(taskId);
    }
  }

  const ready = [...byId.values()].filter((task) => indegree.get(task.taskId) === 0).sort(compareTask);
  const sorted: NormalizedTask<Input>[] = [];
  while (ready.length) {
    const task = ready.shift()!;
    sorted.push(task);
    for (const nextId of successors.get(task.taskId)!) {
      const nextIndegree = indegree.get(nextId)! - 1;
      indegree.set(nextId, nextIndegree);
      if (nextIndegree === 0) {
        ready.push(byId.get(nextId)!);
        ready.sort(compareTask);
      }
    }
  }
  if (sorted.length !== byId.size) {
    const cyclic = [...byId.keys()].filter((taskId) => indegree.get(taskId)! > 0).sort();
    throw new DagSchedulerError('DEPENDENCY_CYCLE', `DAG contains a dependency cycle involving ${cyclic.join(', ')}`, cyclic[0]);
  }
  return sorted;
}

function errorInfo(error: unknown): DagTaskError {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate.code) ? candidate.code : 'TASK_FAILED';
    const message = typeof candidate.message === 'string' ? candidate.message : 'Task failed';
    return {
      code,
      message: message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512) || 'Task failed',
      retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : false
    };
  }
  return { code: 'TASK_FAILED', message: 'Task failed', retryable: false };
}

/**
 * Execute a validated region DAG with a bounded worker pool. Results are returned
 * in deterministic topological order, regardless of worker completion timing.
 */
export async function runDagScheduler<Input, Result>(options: RunDagOptions<Input, Result>): Promise<DagSchedulerResult<Input, Result>> {
  if (![1, 3, 5].includes(options.maxParallel)) {
    throw new DagSchedulerError('INVALID_MAX_PARALLEL', 'maxParallel must be one of 1, 3, or 5');
  }
  if (typeof options.worker !== 'function') throw new DagSchedulerError('INVALID_TASK', 'DAG worker must be a function');
  const tasks = normalizeAndSort(options.tasks);
  const runId = options.runId ?? `run_${randomUUID().replaceAll('-', '')}`;
  const attemptId = options.attemptId ?? `attempt_${randomUUID().replaceAll('-', '')}`;
  const records = new Map<string, MutableResult<Input, Result>>();
  for (const task of tasks) records.set(task.taskId, { task, state: 'queued' });

  let active = 0;
  let maxObservedParallel = 0;
  let nextLeaseOrdinal = 0;
  let cancelled = false;
  let finished = false;
  let finish!: (result: DagSchedulerResult<Input, Result>) => void;
  const resultPromise = new Promise<DagSchedulerResult<Input, Result>>((resolve) => { finish = resolve; });

  const emit = (record: MutableResult<Input, Result>, state: DagTaskState, error?: DagTaskError) => {
    record.state = state;
    if (error) record.error = error;
    const event: DagTaskEvent = {
      runId, attemptId, taskId: record.task.taskId,
      ...(record.leaseId ? { leaseId: record.leaseId } : {}), state,
      ...(error ? { error } : {})
    };
    try { options.onTaskEvent?.(event); } catch { /* Observers cannot break task scheduling. */ }
  };

  const snapshot = (): DagSchedulerResult<Input, Result> => {
    const ordered = tasks.map((task) => {
      const record = records.get(task.taskId)!;
      return {
        task: { taskId: task.taskId, order: task.order, dependencies: [...task.dependencies], input: task.input },
        state: record.state as DagTaskTerminalState,
        ...(record.leaseId ? { leaseId: record.leaseId } : {}),
        ...(record.state === 'completed' ? { result: record.result } : {}),
        ...(record.error ? { error: { ...record.error } } : {})
      };
    });
    const state = cancelled ? 'cancelled' : ordered.some((task) => task.state === 'failed' || task.state === 'blocked') ? 'partial' : 'completed';
    return { runId, attemptId, state, maxObservedParallel, tasks: ordered };
  };

  const finalize = () => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener('abort', onAbort);
    finish(snapshot());
  };

  const onAbort = () => {
    if (finished || cancelled) return;
    cancelled = true;
    for (const record of records.values()) {
      if (record.state === 'queued' || record.state === 'running') emit(record, 'cancelled');
    }
    // Do not wait for an uncooperative worker. Its promise handlers remain attached,
    // but its lease is no longer current and its eventual value is discarded.
    finalize();
  };

  const leaseIdFor = (taskId: string): string => {
    const ordinal = ++nextLeaseOrdinal;
    return options.leaseIdFactory?.(taskId, attemptId, ordinal)
      ?? `lease_${randomUUID().replaceAll('-', '')}`;
  };

  const hasFailedDependency = (task: NormalizedTask<Input>) => task.dependencies.some((dependency) => {
    const state = records.get(dependency)!.state;
    return state === 'failed' || state === 'blocked' || state === 'cancelled' || state === 'stale';
  });

  const makeDependencyResults = (task: NormalizedTask<Input>): ReadonlyMap<string, Result> => {
    const results = new Map<string, Result>();
    for (const dependency of task.dependencies) {
      const record = records.get(dependency)!;
      if (record.state !== 'completed') continue;
      results.set(dependency, record.result as Result);
    }
    return results;
  };

  const settleWorker = (record: MutableResult<Input, Result>, leaseId: string, succeeded: boolean, value: unknown) => {
    active = Math.max(0, active - 1);
    const current = !finished && !cancelled && record.state === 'running' && record.leaseId === leaseId;
    if (!current) return;
    if (succeeded) {
      record.result = value as Result;
      emit(record, 'completed');
    } else {
      emit(record, 'failed', errorInfo(value));
    }
    pump();
  };

  const launch = (record: MutableResult<Input, Result>) => {
    const leaseId = leaseIdFor(record.task.taskId);
    record.leaseId = leaseId;
    active++;
    maxObservedParallel = Math.max(maxObservedParallel, active);
    emit(record, 'running');
    if (cancelled || finished || record.state !== 'running') {
      active = Math.max(0, active - 1);
      return;
    }
    const context: DagTaskContext<Result> = {
      runId, attemptId, leaseId,
      ...(options.signal ? { signal: options.signal } : {}),
      isCurrent: () => !finished && !cancelled && record.state === 'running' && record.leaseId === leaseId,
      dependencyResults: makeDependencyResults(record.task)
    };
    // Attach both handlers immediately. This consumes late failures after cancellation
    // while the run result itself can return without waiting for an uncooperative worker.
    void Promise.resolve().then(() => options.worker(record.task, context)).then(
      (value) => settleWorker(record, leaseId, true, value),
      (error: unknown) => settleWorker(record, leaseId, false, error)
    );
  };

  function pump(): void {
    if (finished) return;
    if (cancelled) { finalize(); return; }

    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        const record = records.get(task.taskId)!;
        if (record.state === 'queued' && hasFailedDependency(task)) {
          emit(record, 'blocked', { code: 'DEPENDENCY_FAILED', message: 'A prerequisite task did not complete successfully', retryable: false });
          changed = true;
        }
      }
    }

    while (!cancelled && active < options.maxParallel) {
      const next = tasks.find((task) => {
        const record = records.get(task.taskId)!;
        return record.state === 'queued' && task.dependencies.every((dependency) => records.get(dependency)!.state === 'completed');
      });
      if (!next) break;
      launch(records.get(next.taskId)!);
    }

    const allSettled = [...records.values()].every((record) => TERMINAL.has(record.state));
    if ((allSettled && active === 0) || cancelled) finalize();
  }

  for (const record of records.values()) emit(record, 'queued');
  if (options.signal?.aborted) onAbort();
  else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
    pump();
  }
  return resultPromise;
}

import { createRequire } from 'node:module';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactsDirectory = path.join(rootDirectory, 'artifacts');
const outputDirectory = path.join(artifactsDirectory, 's5-perf');
const now = new Date();
const runId = `run-${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`;
const runDirectory = path.join(outputDirectory, runId);
const require = createRequire(import.meta.url);

const CHILD_NODE_COUNTS = [250, 1_000, 3_000];
const COLD_SAMPLES = 9;
const HOT_ITERATIONS_PER_SAMPLE = 10;
const JOURNAL_COMMITS = 5;
const RSS_SAMPLE_INTERVAL_MS = 25;

const { appendDesignJournalCommit, loadRecoverableDesignDocument, saveDesignSnapshot } = require(path.join(rootDirectory, 'packages/storage/dist/index.js'));
const { renderDocumentScreenshot } = require(path.join(rootDirectory, 'packages/renderer-canvas/dist/index.js'));

async function countDirectoryEntries(directory, excludedNames = new Set()) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return { entries: 0, files: 0, directories: 0, other: 0 };
    throw error;
  }
  const included = entries.filter((entry) => !excludedNames.has(entry.name));
  return {
    entries: included.length,
    files: included.filter((entry) => entry.isFile()).length,
    directories: included.filter((entry) => entry.isDirectory()).length,
    other: included.filter((entry) => !entry.isFile() && !entry.isDirectory()).length
  };
}

async function artifactInventory() {
  return {
    artifactRootTopLevel: await countDirectoryEntries(artifactsDirectory, new Set(['s5-perf'])),
    s5PerfTopLevelBeforeOwnRun: await countDirectoryEntries(outputDirectory, new Set([runId]))
  };
}

function emptyStyle(fill = '#f4f6f8') {
  return { fills: [{ type: 'solid', color: fill }], strokes: [], effects: [], opacity: 1 };
}

function syntheticDocument(childCount, sampleIndex) {
  const documentId = `perfdoc_${String(childCount).padStart(4, '0')}_${String(sampleIndex).padStart(2, '0')}`;
  const children = Array.from({ length: childCount }, (_, index) => {
    const column = index % 60;
    const row = Math.floor(index / 60);
    return {
      id: `node_${String(index + 1).padStart(5, '0')}`,
      type: 'rectangle',
      name: `Synthetic card ${index + 1}`,
      visible: true,
      locked: false,
      bounds: { x: 16 + column * 26, y: 16 + row * 24, width: 22, height: 18 },
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { ...emptyStyle(index % 2 === 0 ? '#e8efff' : '#e9f5ed'), fills: [{ type: 'solid', color: index % 2 === 0 ? '#e8efff' : '#e9f5ed' }] },
      radius: 3
    };
  });
  return {
    documentVersion: '1.0',
    documentId,
    fileToken: `synthetic-file-token-${String(sampleIndex).padStart(2, '0')}`,
    revision: 0,
    title: `Synthetic performance fixture ${childCount}`,
    pages: [{
      id: 'page_synthetic',
      name: 'Synthetic performance page',
      root: {
        id: 'frame_synthetic',
        type: 'frame',
        name: 'Synthetic performance frame',
        visible: true,
        locked: false,
        bounds: { x: 0, y: 0, width: 1_600, height: 1_600 },
        transform: { rotation: 0, scaleX: 1, scaleY: 1 },
        style: emptyStyle(),
        children,
        layout: { mode: 'absolute' },
        clipContent: true
      }
    }],
    variables: {},
    assets: {}
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upperValue = sorted[lower + 1] ?? sorted[lower];
  return Number((sorted[lower] + (upperValue - sorted[lower]) * fraction).toFixed(3));
}

function summarizeSamples(samples) {
  return {
    count: samples.length,
    unit: 'ms',
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    min: Number(Math.min(...samples).toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3))
  };
}

function timeSync(operation) {
  const start = performance.now();
  const result = operation();
  return { result, milliseconds: performance.now() - start };
}

async function timeAsync(operation) {
  const start = performance.now();
  const result = await operation();
  return { result, milliseconds: performance.now() - start };
}

function bytesOfJson(value) { return Buffer.byteLength(JSON.stringify(value)); }

const electronPackage = require(path.join(rootDirectory, 'node_modules/electron/package.json'));
const freeMemoryAtStart = os.freemem();
const beforeArtifactInventory = await artifactInventory();
await mkdir(outputDirectory, { recursive: true });
await mkdir(runDirectory, { recursive: true });

let peakSampledRssBytes = process.memoryUsage().rss;
const rssSampler = setInterval(() => {
  peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
}, RSS_SAMPLE_INTERVAL_MS);
rssSampler.unref();

const recoverySamples = new Map(CHILD_NODE_COUNTS.map((count) => [count, { first: [], hot: [] }]));
const screenshotSamples = new Map(CHILD_NODE_COUNTS.map((count) => [count, { first: [], hot: [] }]));
const targetedScreenshotSamples = new Map(CHILD_NODE_COUNTS.map((count) => [count, { first: [], hot: [] }]));
const workloads = [];

try {
  // Warm module/JIT paths on a tiny in-memory fixture; these timings are intentionally excluded.
  const warmupDocument = syntheticDocument(20, 0);
  renderDocumentScreenshot(warmupDocument);
  const warmupDirectory = path.join(runDirectory, 'synthetic-workspace');
  await saveDesignSnapshot(warmupDirectory, 'warmup_project', warmupDocument);
  const warmupRevision = { ...warmupDocument, revision: 1, title: 'Synthetic warm-up revision' };
  await appendDesignJournalCommit(warmupDirectory, 'warmup_project', {
    commandId: 'warmup_command_1', baseRevision: 0, nextRevision: 1,
    commands: [{ type: 'SetTitle', title: warmupRevision.title }], origin: 'human', document: warmupRevision
  });
  await loadRecoverableDesignDocument(warmupDirectory, 'warmup_project', warmupDocument.documentId);

  for (const childCount of CHILD_NODE_COUNTS) {
    const measurements = {
      childNodes: childCount,
      totalNodes: childCount + 1,
      journalCommits: JOURNAL_COMMITS,
      documentJsonBytes: null,
      journalBytes: 0,
      firstRecovery: [],
      hotRecovery: [],
      firstFullScreenshot: [],
      hotFullScreenshot: [],
      firstTargetedScreenshot: [],
      hotTargetedScreenshot: []
    };

    for (let sampleIndex = 1; sampleIndex <= COLD_SAMPLES; sampleIndex++) {
      const document = syntheticDocument(childCount, sampleIndex);
      measurements.documentJsonBytes ??= bytesOfJson(document);
      const projectId = `perf_${String(childCount).padStart(4, '0')}_${String(sampleIndex).padStart(2, '0')}`;
      await saveDesignSnapshot(warmupDirectory, projectId, document);
      let current = document;
      for (let revision = 1; revision <= JOURNAL_COMMITS; revision++) {
        current = { ...current, revision, title: `Synthetic fixture ${childCount} at revision ${revision}` };
        await appendDesignJournalCommit(warmupDirectory, projectId, {
          commandId: `perf_${childCount}_${sampleIndex}_cmd_${revision}`,
          baseRevision: revision - 1,
          nextRevision: revision,
          commands: [{ type: 'SetTitle', title: current.title }],
          origin: 'human',
          document: current
        });
      }

      const coldRecovery = await timeAsync(() => loadRecoverableDesignDocument(warmupDirectory, projectId, document.documentId));
      if (coldRecovery.result.document.revision !== JOURNAL_COMMITS || coldRecovery.result.replayedCommits !== JOURNAL_COMMITS) {
        throw new Error(`Recovery fixture ${projectId} did not replay the expected commits`);
      }
      measurements.firstRecovery.push(coldRecovery.milliseconds);
      recoverySamples.get(childCount).first.push(coldRecovery.milliseconds);
      const journalPath = path.join(warmupDirectory, projectId, 'journal', `${document.documentId}.jsonl`);
      measurements.journalBytes += (await stat(journalPath)).size;

      const fullFirst = timeSync(() => renderDocumentScreenshot(document));
      if (fullFirst.result.metadata.nodeIds.length !== childCount + 1) throw new Error('Full screenshot fixture node count mismatch');
      measurements.firstFullScreenshot.push(fullFirst.milliseconds);
      screenshotSamples.get(childCount).first.push(fullFirst.milliseconds);

      const targetIds = ['node_00001'];
      const targetedFirst = timeSync(() => renderDocumentScreenshot(document, 'page_synthetic', 1, 4_096, targetIds));
      if (!targetedFirst.result.metadata.nodeIds.includes('node_00001')) throw new Error('Targeted screenshot omitted the requested node');
      measurements.firstTargetedScreenshot.push(targetedFirst.milliseconds);
      targetedScreenshotSamples.get(childCount).first.push(targetedFirst.milliseconds);

      for (let iteration = 0; iteration < HOT_ITERATIONS_PER_SAMPLE; iteration++) {
        const hotRecovery = await timeAsync(() => loadRecoverableDesignDocument(warmupDirectory, projectId, document.documentId));
        if (hotRecovery.result.document.revision !== JOURNAL_COMMITS) throw new Error('Hot recovery returned an unexpected revision');
        measurements.hotRecovery.push(hotRecovery.milliseconds);
        recoverySamples.get(childCount).hot.push(hotRecovery.milliseconds);

        const fullHot = timeSync(() => renderDocumentScreenshot(document));
        measurements.hotFullScreenshot.push(fullHot.milliseconds);
        screenshotSamples.get(childCount).hot.push(fullHot.milliseconds);

        const targetedHot = timeSync(() => renderDocumentScreenshot(document, 'page_synthetic', 1, 4_096, targetIds));
        measurements.hotTargetedScreenshot.push(targetedHot.milliseconds);
        targetedScreenshotSamples.get(childCount).hot.push(targetedHot.milliseconds);
      }
      peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
    }

    const workload = {
      childNodeCount: measurements.childNodes,
      totalNodeCount: measurements.totalNodes,
      pageCount: 1,
      assetCount: 0,
      documentJsonBytes: measurements.documentJsonBytes,
      journalCommitCountPerSample: measurements.journalCommits,
      meanJournalBytesPerSample: Math.round(measurements.journalBytes / COLD_SAMPLES),
      independentFirstReadSamples: measurements.firstRecovery.length,
      recoveryMs: {
        coldFirstRead: summarizeSamples(measurements.firstRecovery),
        hotRepeated: summarizeSamples(measurements.hotRecovery)
      },
      fullSvgScreenshotMs: {
        firstCall: summarizeSamples(measurements.firstFullScreenshot),
        hotRepeated: summarizeSamples(measurements.hotFullScreenshot)
      },
      targetedSvgScreenshotMs: {
        firstCall: summarizeSamples(measurements.firstTargetedScreenshot),
        hotRepeated: summarizeSamples(measurements.hotTargetedScreenshot)
      }
    };
    workloads.push(workload);
  }
} finally {
  clearInterval(rssSampler);
}

peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
const resourceMaxRss = process.resourceUsage().maxRSS;
const kernelPeakRssBytes = Math.round(resourceMaxRss * (process.platform === 'win32' ? 1 : 1_024));
const peakRssBytes = Math.max(peakSampledRssBytes, kernelPeakRssBytes);
const cpuList = os.cpus();
const report = {
  schemaVersion: 1,
  runId,
  generatedAt: now.toISOString(),
  syntheticDataOnly: true,
  modelCalls: 0,
  userProjectFilesRead: false,
  environment: {
    osPlatform: os.platform(),
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : 'unavailable',
    architecture: os.arch(),
    cpuModel: cpuList[0]?.model ?? 'unavailable',
    logicalCpuCount: cpuList.length,
    availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpuList.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryAtStartBytes: freeMemoryAtStart,
    nodeVersion: process.version,
    electronVersion: electronPackage.version
  },
  benchmark: {
    implementation: 'Node.js main-process library modules, direct local calls',
    operations: ['loadRecoverableDesignDocument (journal replay)', 'renderDocumentScreenshot (full SVG)', 'renderDocumentScreenshot (targeted SVG)'],
    childNodeScales: CHILD_NODE_COUNTS,
    journalCommitsPerSyntheticDocument: JOURNAL_COMMITS,
    independentFirstReadSamplesPerScale: COLD_SAMPLES,
    hotIterationsPerSample: HOT_ITERATIONS_PER_SAMPLE,
    hotIterationCountsPerScale: COLD_SAMPLES * HOT_ITERATIONS_PER_SAMPLE,
    rssSampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
    peakSampledRssBytes,
    processResourceUsageMaxRssBytes: kernelPeakRssBytes,
    peakRssBytes,
    workloads
  },
  artifactIntegrity: {
    verified: false,
    method: 'compare top-level entry/file/directory counts; no existing artifact contents are opened or hashed',
    before: beforeArtifactInventory,
    after: null
  }
};

const resultsPath = path.join(runDirectory, 'results.json');
const summaryPath = path.join(runDirectory, 'summary.md');
await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const table = workloads.map((workload) => `| ${workload.totalNodeCount.toLocaleString('en-US')} | ${workload.documentJsonBytes.toLocaleString('en-US')} | ${workload.meanJournalBytesPerSample.toLocaleString('en-US')} | ${workload.recoveryMs.coldFirstRead.p50} / ${workload.recoveryMs.coldFirstRead.p95} | ${workload.recoveryMs.hotRepeated.p50} / ${workload.recoveryMs.hotRepeated.p95} | ${workload.fullSvgScreenshotMs.firstCall.p50} / ${workload.fullSvgScreenshotMs.firstCall.p95} | ${workload.fullSvgScreenshotMs.hotRepeated.p50} / ${workload.fullSvgScreenshotMs.hotRepeated.p95} |`).join('\n');
const summary = `# S5 performance smoke result — ${runId}\n\n- Generated: ${report.generatedAt}\n- OS: ${report.environment.osPlatform} ${report.environment.osRelease} (${report.environment.osVersion}) ${report.environment.architecture}\n- CPU: ${report.environment.cpuModel}; ${report.environment.logicalCpuCount} logical cores (${report.environment.availableParallelism} available parallelism)\n- Memory: ${(report.environment.totalMemoryBytes / 1_073_741_824).toFixed(1)} GiB total; ${(report.benchmark.peakRssBytes / 1_073_741_824).toFixed(2)} GiB peak process RSS\n- Runtime: Node ${report.environment.nodeVersion}; Electron ${report.environment.electronVersion}\n- Data: deterministic synthetic documents only; 1 page, 0 assets, ${JOURNAL_COMMITS} journal commits, ${COLD_SAMPLES} independent first-read samples and ${HOT_ITERATIONS_PER_SAMPLE * COLD_SAMPLES} repeated samples per scale\n- Operations: persistence replay and full/targeted SVG rendering from repository modules; no model calls and no user project reads\n\n| Total nodes | JSON bytes | Mean journal bytes/sample | Replay first-read p50 / p95 (ms) | Replay repeated p50 / p95 (ms) | Full SVG first-call p50 / p95 (ms) | Full SVG repeated p50 / p95 (ms) |\n|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\nThe first-read measurement is a first application-level recovery call after fixture creation. The OS page cache is not flushed, so it is **not** a cold-disk measurement. This is one local developer-machine smoke run, not a general SLA. RSS is sampled every ${RSS_SAMPLE_INTERVAL_MS} ms and may miss shorter transient peaks. Existing artifacts are protected by comparing top-level entry/file/directory counts before and after; the benchmark does not open or hash existing artifact contents.\n`;
await writeFile(summaryPath, summary, 'utf8');

const afterArtifactInventory = await artifactInventory();
report.artifactIntegrity.after = afterArtifactInventory;
report.artifactIntegrity.verified = JSON.stringify(beforeArtifactInventory) === JSON.stringify(afterArtifactInventory);
await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!report.artifactIntegrity.verified) throw new Error(`Existing artifacts top-level inventory changed: ${JSON.stringify({ before: beforeArtifactInventory, after: afterArtifactInventory })}`);

console.log(JSON.stringify({ runId, resultsPath, summaryPath, peakRssBytes, existingArtifactsUnchanged: true, workloads }, null, 2));

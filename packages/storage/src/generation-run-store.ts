import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  generationEventSchema,
  generationRunCheckpointSchema,
  screenshotEvidenceContentSchema,
  type GenerationEvent,
  type GenerationRunCheckpoint,
  type ScreenshotEvidenceContent
} from '@miaoma/shared-protocol';
import { StoragePersistenceError } from './persistence';

const projectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_EVENT_LOG_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_RUN_BYTES = 128 * 1024 * 1024;
const MAX_CHECKPOINTS = 50;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type StoredCheckpoint = {
  kind: 'generation-run-checkpoint';
  formatVersion: 1;
  checkpointId: string;
  checkpoint: GenerationRunCheckpoint;
  checksum: string;
};

type StoredEvidence = {
  kind: 'screenshot-evidence';
  formatVersion: 1;
  evidence: ScreenshotEvidenceContent['evidence'];
  checksum: string;
};

type StoredEvent = {
  kind: 'generation-run-event';
  formatVersion: 1;
  previousChecksum: string | null;
  event: GenerationEvent;
  checksum: string;
};

export type SavedGenerationRunCheckpoint = {
  checkpointId: string;
  checkpointPath: string;
  checkpoint: GenerationRunCheckpoint;
};

export type GenerationRunCheckpointSummary = {
  checkpointId: string;
  attemptId: string;
  phase: GenerationRunCheckpoint['phase'];
  eventSeq: number;
  updatedAt: string;
};

export type AppendedGenerationRunEvent = {
  eventPath: string;
  eventSeq: number;
  checksum: string;
};

export type ReadGenerationRunEventsResult = {
  events: GenerationEvent[];
  ignoredTailBytes: number;
  validBytes: number;
};

export type SavedScreenshotEvidence = {
  evidenceId: string;
  svgPath: string;
  metadataPath: string;
  imageHash: string;
};

type EventLogState = {
  events: GenerationEvent[];
  checksums: string[];
  validBytes: number;
  ignoredTailBytes: number;
  finalChecksum: string | null;
};

type EventCursor = {
  size: bigint;
  mtimeNs: bigint;
  eventCount: number;
  finalChecksum: string | null;
};

const runLocks = new Map<string, Promise<void>>();
const eventCursors = new Map<string, EventCursor>();

function fail(code: string, message: string): never {
  throw new StoragePersistenceError(code, message);
}

function assertProjectId(projectId: string): void {
  if (!projectIdPattern.test(projectId)) fail('INVALID_PROJECT_ID', 'Invalid project ID');
}

function assertId(id: string, label: string): void {
  if (!idPattern.test(id)) fail('INVALID_RUN_STORE_ID', `${label} is invalid`);
}

function canonicalJson(value: unknown, label: string): { value: JsonValue; text: string } {
  const active = new WeakSet<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > 64 || ++count > 100_000) fail('JSON_LIMIT', `${label} exceeds the JSON complexity limit`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('INVALID_JSON', `${label} contains a non-finite number`);
      return item;
    }
    if (!item || typeof item !== 'object') fail('INVALID_JSON', `${label} must contain JSON values only`);
    if (active.has(item)) fail('INVALID_JSON', `${label} cannot contain cycles`);
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const ownKeys = Reflect.ownKeys(item);
        if (ownKeys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('INVALID_JSON', `${label} arrays cannot contain custom keys`);
        const output: JsonValue[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('INVALID_JSON', `${label} arrays cannot contain holes or accessors`);
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) fail('INVALID_JSON', `${label} must contain plain JSON objects`);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) fail('INVALID_JSON', `${label} cannot contain symbol keys`);
      const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor) || !descriptor.enumerable) fail('INVALID_JSON', `${label} cannot contain accessors or hidden fields`);
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(item);
    }
  };
  const normalized = visit(value, 0);
  return { value: normalized, text: JSON.stringify(normalized) };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function resolveProjectDirectory(rootDirectory: string, projectId: string, create: boolean): Promise<string> {
  assertProjectId(projectId);
  const absoluteRoot = path.resolve(rootDirectory);
  if (create) await mkdir(absoluteRoot, { recursive: true });
  let actualRoot: string;
  try { actualRoot = await realpath(absoluteRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('RUN_NOT_FOUND', 'Project storage root does not exist'); throw error; }
  const projectPath = path.join(actualRoot, projectId);
  if (create) await mkdir(projectPath, { recursive: true });
  let projectStats;
  try { projectStats = await lstat(projectPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('RUN_NOT_FOUND', 'Project does not exist'); throw error; }
  if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) fail('UNSAFE_PATH', 'Project path cannot be a symbolic link and must be a directory');
  const actualProject = await realpath(projectPath);
  if (path.dirname(actualProject) !== actualRoot) fail('UNSAFE_PATH', 'Project directory escaped the selected workspace');
  return actualProject;
}

async function resolveChildDirectory(parent: string, childName: string, create: boolean): Promise<string> {
  if (!childName || childName === '.' || childName === '..' || childName.includes(path.sep) || childName.includes(path.posix.sep) && path.sep !== path.posix.sep) fail('UNSAFE_PATH', 'Invalid storage directory name');
  const childPath = path.join(parent, childName);
  if (create) await mkdir(childPath, { recursive: true });
  let details;
  try { details = await lstat(childPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('RUN_NOT_FOUND', 'Run storage directory does not exist'); throw error; }
  if (details.isSymbolicLink() || !details.isDirectory()) fail('UNSAFE_PATH', 'Storage paths cannot use symbolic links and must be directories');
  const actual = await realpath(childPath);
  if (path.dirname(actual) !== parent) fail('UNSAFE_PATH', 'Storage directory escaped its parent');
  return actual;
}

async function resolveRunDirectory(rootDirectory: string, projectId: string, runId: string, create: boolean): Promise<string> {
  assertId(runId, 'Run ID');
  const projectDirectory = await resolveProjectDirectory(rootDirectory, projectId, create);
  const runsDirectory = await resolveChildDirectory(projectDirectory, 'runs', create);
  return resolveChildDirectory(runsDirectory, runId, create);
}

async function hasRunCheckpointOrEvent(runDirectory: string): Promise<boolean> {
  const entries = await readdir(runDirectory);
  if (entries.includes('events.jsonl')) {
    const eventPath = path.join(runDirectory, 'events.jsonl');
    const details = await lstat(eventPath);
    if (!details.isFile() || details.isSymbolicLink()) fail('UNSAFE_PATH', 'Run event log must be a regular file');
    if (details.size > 0) return true;
  }
  if (!entries.includes('checkpoints')) return false;
  const checkpointsPath = path.join(runDirectory, 'checkpoints');
  const directoryInfo = await lstat(checkpointsPath);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) fail('UNSAFE_PATH', 'Checkpoint storage must be a real directory');
  const actualCheckpoints = await realpath(checkpointsPath);
  if (path.dirname(actualCheckpoints) !== runDirectory) fail('UNSAFE_PATH', 'Checkpoint directory escaped its Run');
  for (const name of await readdir(actualCheckpoints)) {
    if (!name.endsWith('.json')) continue;
    const checkpointId = name.slice(0, -'.json'.length);
    if (!idPattern.test(checkpointId)) continue;
    const filePath = path.join(actualCheckpoints, name);
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) fail('UNSAFE_PATH', 'Run checkpoint must be a regular file');
    if (details.size > 0) return true;
  }
  return false;
}

/** Discover only safe real run directories that already contain durable run data. */
export async function listGenerationRunIds(rootDirectory: string, projectId: string): Promise<string[]> {
  assertProjectId(projectId);
  let projectDirectory: string;
  try { projectDirectory = await resolveProjectDirectory(rootDirectory, projectId, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'RUN_NOT_FOUND') return []; throw error; }
  let runsDirectory: string;
  try { runsDirectory = await resolveChildDirectory(projectDirectory, 'runs', false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'RUN_NOT_FOUND') return []; throw error; }
  const runIds: string[] = [];
  for (const entry of await readdir(runsDirectory)) {
    const entryPath = path.join(runsDirectory, entry);
    const details = await lstat(entryPath);
    if (details.isSymbolicLink()) fail('UNSAFE_PATH', 'Run directories cannot be symbolic links');
    if (!details.isDirectory() || !idPattern.test(entry)) continue;
    const actualRun = await realpath(entryPath);
    if (path.dirname(actualRun) !== runsDirectory) fail('UNSAFE_PATH', 'Run directory escaped the project runs directory');
    if (await hasRunCheckpointOrEvent(actualRun)) runIds.push(entry);
  }
  return runIds.sort((left, right) => left.localeCompare(right));
}

async function withRunLock<T>(runDirectory: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(runDirectory).toLowerCase();
  const previous = runLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  runLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (runLocks.get(key) === current) runLocks.delete(key);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'ENOSYS'].includes(code ?? '')) throw error;
  } finally { await handle?.close(); }
}

async function ensureRegularTarget(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) fail('UNSAFE_PATH', 'Run store files must be regular files');
    return details;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readRegularFile(filePath: string, maxBytes: number, code: string): Promise<Buffer> {
  await ensureRegularTarget(filePath);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile()) fail('UNSAFE_PATH', 'Run store files must be regular files');
    if (details.size > maxBytes) fail(code, `Stored file exceeds ${maxBytes} bytes`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function atomicReplaceFile(filePath: string, content: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureRegularTarget(filePath);
  const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createImmutableFile(filePath: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  const existing = await ensureRegularTarget(filePath);
  if (existing) {
    const prior = await readRegularFile(filePath, MAX_EVIDENCE_BYTES, 'EVIDENCE_TOO_LARGE');
    if (!prior.equals(bytes)) fail('EVIDENCE_CONFLICT', 'An immutable evidence ID already stores different content');
    return;
  }
  const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporaryPath, filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = await readRegularFile(filePath, MAX_EVIDENCE_BYTES, 'EVIDENCE_TOO_LARGE');
      if (!prior.equals(bytes)) fail('EVIDENCE_CONFLICT', 'An immutable evidence ID already stores different content');
    }
    await unlink(temporaryPath);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function measureRunBytes(runDirectory: string): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const filePath = path.join(directory, entry);
      const details = await lstat(filePath);
      if (details.isSymbolicLink()) fail('UNSAFE_PATH', 'Run storage cannot contain symbolic links');
      if (details.isDirectory()) {
        const actual = await realpath(filePath);
        if (path.dirname(actual) !== directory) fail('UNSAFE_PATH', 'Run storage directory escaped its parent');
        await visit(actual);
      } else if (details.isFile()) {
        total += details.size;
        if (total > MAX_RUN_BYTES) fail('RUN_TOO_LARGE', `Run storage exceeds ${MAX_RUN_BYTES} bytes`);
      } else fail('UNSAFE_PATH', 'Run storage contains an unsupported filesystem entry');
    }
  };
  await visit(runDirectory);
  return total;
}

function checkpointEnvelope(checkpointId: string, checkpoint: GenerationRunCheckpoint): StoredCheckpoint {
  const body = { kind: 'generation-run-checkpoint' as const, formatVersion: 1 as const, checkpointId, checkpoint };
  const canonical = canonicalJson(body, 'generation run checkpoint');
  return { ...body, checksum: sha256(canonical.text) };
}

function parseCheckpoint(value: unknown, expected: { projectId: string; runId: string; checkpointId: string }): StoredCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CHECKPOINT_INVALID', 'Checkpoint file must contain an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['kind', 'formatVersion', 'checkpointId', 'checkpoint', 'checksum'].includes(key))) fail('CHECKPOINT_INVALID', 'Checkpoint contains unknown fields');
  if (record.kind !== 'generation-run-checkpoint' || record.formatVersion !== 1 || record.checkpointId !== expected.checkpointId || typeof record.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(record.checksum)) fail('CHECKPOINT_INVALID', 'Checkpoint envelope is invalid');
  const parsed = generationRunCheckpointSchema.safeParse(record.checkpoint);
  if (!parsed.success) fail('CHECKPOINT_INVALID', `Checkpoint schema validation failed: ${parsed.error.issues[0]?.message ?? 'invalid checkpoint'}`);
  if (parsed.data.projectId !== expected.projectId || parsed.data.runId !== expected.runId) fail('CHECKPOINT_IDENTITY_MISMATCH', 'Checkpoint identity does not match its storage path');
  const body = { kind: 'generation-run-checkpoint' as const, formatVersion: 1 as const, checkpointId: record.checkpointId as string, checkpoint: parsed.data };
  const canonical = canonicalJson(body, 'generation run checkpoint');
  if (sha256(canonical.text) !== record.checksum) fail('CHECKPOINT_HASH_MISMATCH', 'Checkpoint checksum does not match its content');
  return { ...body, checksum: record.checksum };
}

function encodeRecord(value: unknown, label: string): Buffer {
  const canonical = canonicalJson(value, label);
  const bytes = Buffer.from(canonical.text, 'utf8');
  if (bytes.byteLength > MAX_RECORD_BYTES) fail('RUN_RECORD_TOO_LARGE', `${label} exceeds ${MAX_RECORD_BYTES} bytes`);
  return bytes;
}

/** Persist an immutable, checksummed checkpoint beneath the project run directory. */
export async function saveGenerationRunCheckpoint(
  rootDirectory: string,
  checkpointInput: GenerationRunCheckpoint,
  checkpointIdInput?: string
): Promise<SavedGenerationRunCheckpoint> {
  const parsed = generationRunCheckpointSchema.safeParse(checkpointInput);
  if (!parsed.success) fail('CHECKPOINT_INVALID', `Checkpoint schema validation failed: ${parsed.error.issues[0]?.message ?? 'invalid checkpoint'}`);
  const checkpoint = parsed.data;
  const checkpointId = checkpointIdInput ?? checkpoint.loop.checkpointId ?? `cp_${randomUUID().replaceAll('-', '')}`;
  assertId(checkpointId, 'Checkpoint ID');
  const runDirectory = await resolveRunDirectory(rootDirectory, checkpoint.projectId, checkpoint.runId, true);
  return withRunLock(runDirectory, async () => {
    const checkpointsDirectory = await resolveChildDirectory(runDirectory, 'checkpoints', true);
    const checkpointPath = path.join(checkpointsDirectory, `${checkpointId}.json`);
    const bytes = encodeRecord(checkpointEnvelope(checkpointId, checkpoint), 'generation run checkpoint');
    const existing = await ensureRegularTarget(checkpointPath);
    if (!existing) {
      const names = await readdir(checkpointsDirectory);
      const files = names.filter((name) => name.endsWith('.json'));
      if (files.length >= MAX_CHECKPOINTS) fail('CHECKPOINT_LIMIT', `A run may retain at most ${MAX_CHECKPOINTS} checkpoints`);
    }
    const currentBytes = await measureRunBytes(runDirectory);
    if (currentBytes - (existing ? Number(existing.size) : 0) + bytes.byteLength > MAX_RUN_BYTES) fail('RUN_TOO_LARGE', `Run storage would exceed ${MAX_RUN_BYTES} bytes`);
    await atomicReplaceFile(checkpointPath, bytes);
    return { checkpointId, checkpointPath, checkpoint: structuredClone(checkpoint) };
  });
}

/** Load one checkpoint and verify its envelope checksum and project/run identity. */
export async function loadGenerationRunCheckpoint(
  rootDirectory: string,
  projectId: string,
  runId: string,
  checkpointId: string
): Promise<GenerationRunCheckpoint> {
  assertId(checkpointId, 'Checkpoint ID');
  const runDirectory = await resolveRunDirectory(rootDirectory, projectId, runId, false);
  const checkpointsDirectory = await resolveChildDirectory(runDirectory, 'checkpoints', false);
  const filePath = path.join(checkpointsDirectory, `${checkpointId}.json`);
  const bytes = await readRegularFile(filePath, MAX_RECORD_BYTES, 'RUN_RECORD_TOO_LARGE');
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { fail('CHECKPOINT_INVALID', 'Checkpoint is not valid JSON'); }
  return parseCheckpoint(input, { projectId, runId, checkpointId }).checkpoint;
}

/** List at most 50 verified checkpoint summaries, newest first. */
export async function listGenerationRunCheckpoints(
  rootDirectory: string,
  projectId: string,
  runId: string
): Promise<GenerationRunCheckpointSummary[]> {
  const runDirectory = await resolveRunDirectory(rootDirectory, projectId, runId, false);
  let checkpointsDirectory: string;
  try { checkpointsDirectory = await resolveChildDirectory(runDirectory, 'checkpoints', false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'RUN_NOT_FOUND') return []; throw error; }
  const files = (await readdir(checkpointsDirectory)).filter((name) => name.endsWith('.json'));
  if (files.length > MAX_CHECKPOINTS) fail('CHECKPOINT_LIMIT', `A run may retain at most ${MAX_CHECKPOINTS} checkpoints`);
  const summaries: GenerationRunCheckpointSummary[] = [];
  for (const name of files) {
    const checkpointId = name.slice(0, -'.json'.length);
    assertId(checkpointId, 'Checkpoint ID');
    const bytes = await readRegularFile(path.join(checkpointsDirectory, name), MAX_RECORD_BYTES, 'RUN_RECORD_TOO_LARGE');
    let input: unknown;
    try { input = JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { fail('CHECKPOINT_INVALID', `Checkpoint ${checkpointId} is not valid JSON`); }
    const stored = parseCheckpoint(input, { projectId, runId, checkpointId });
    summaries.push({ checkpointId, attemptId: stored.checkpoint.attemptId, phase: stored.checkpoint.phase, eventSeq: stored.checkpoint.eventSeq, updatedAt: stored.checkpoint.updatedAt });
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.eventSeq - a.eventSeq).slice(0, 50);
}

function eventEnvelope(event: GenerationEvent, previousChecksum: string | null): StoredEvent {
  const body = { kind: 'generation-run-event' as const, formatVersion: 1 as const, previousChecksum, event };
  const canonical = canonicalJson(body, 'generation run event');
  return { ...body, checksum: sha256(canonical.text) };
}

async function parseEventLog(filePath: string, runId: string): Promise<EventLogState> {
  let bytes: Buffer;
  try { bytes = await readRegularFile(filePath, MAX_EVENT_LOG_BYTES, 'EVENT_LOG_TOO_LARGE'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], checksums: [], validBytes: 0, ignoredTailBytes: 0, finalChecksum: null }; throw error; }
  const finalNewline = bytes.lastIndexOf(0x0a);
  const completeLength = finalNewline + 1;
  const ignoredTailBytes = bytes.byteLength - completeLength;
  if (ignoredTailBytes > MAX_RECORD_BYTES) fail('EVENT_TAIL_TOO_LARGE', 'Incomplete event tail exceeds the per-record size limit');
  const events: GenerationEvent[] = [];
  const checksums: string[] = [];
  let validBytes = 0;
  let start = 0;
  let previousChecksum: string | null = null;
  let line = 0;
  while (start < completeLength) {
    const end = bytes.indexOf(0x0a, start);
    if (end < 0 || end >= completeLength) break;
    line++;
    const length = end - start;
    if (length < 1 || length > MAX_RECORD_BYTES) fail('EVENT_RECORD_INVALID', `Event record ${line} is empty or exceeds its size limit`);
    let input: unknown;
    try { input = JSON.parse(bytes.subarray(start, end).toString('utf8')) as unknown; }
    catch { fail('EVENT_LOG_CORRUPT', `Event record ${line} is invalid JSON`); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('EVENT_LOG_CORRUPT', `Event record ${line} must be an object`);
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['kind', 'formatVersion', 'previousChecksum', 'event', 'checksum'].includes(key))) fail('EVENT_LOG_CORRUPT', `Event record ${line} has unknown fields`);
    if (raw.kind !== 'generation-run-event' || raw.formatVersion !== 1 || raw.previousChecksum !== previousChecksum || typeof raw.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(raw.checksum)) fail('EVENT_LOG_CORRUPT', `Event record ${line} envelope or chain is invalid`);
    const parsedEvent = generationEventSchema.safeParse(raw.event);
    if (!parsedEvent.success) fail('EVENT_LOG_CORRUPT', `Event record ${line} failed schema validation: ${parsedEvent.error.issues[0]?.message ?? 'invalid event'}`);
    if (parsedEvent.data.runId !== runId || parsedEvent.data.seq !== line) fail('EVENT_SEQUENCE_INVALID', `Event record ${line} has a mismatched run ID or non-contiguous sequence`);
    const body = { kind: 'generation-run-event' as const, formatVersion: 1 as const, previousChecksum, event: parsedEvent.data };
    const canonical = canonicalJson(body, `event record ${line}`);
    if (sha256(canonical.text) !== raw.checksum) fail('EVENT_CHECKSUM_MISMATCH', `Event record ${line} checksum is invalid`);
    events.push(parsedEvent.data);
    previousChecksum = raw.checksum;
    checksums.push(previousChecksum);
    validBytes = end + 1;
    start = end + 1;
    if (events.length > MAX_EVENTS) fail('EVENT_LIMIT', `A run may retain at most ${MAX_EVENTS} events`);
  }
  return { events, checksums, validBytes, ignoredTailBytes, finalChecksum: previousChecksum };
}

function eventLogPath(runDirectory: string): string { return path.join(runDirectory, 'events.jsonl'); }

function cursorKey(filePath: string): string { return path.resolve(filePath).toLowerCase(); }

async function eventCursorMatches(filePath: string, cursor: EventCursor | undefined): Promise<boolean> {
  if (!cursor) return false;
  const details = await stat(filePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  return !!details && details.isFile() && details.size === cursor.size && details.mtimeNs === cursor.mtimeNs;
}

async function cacheEventCursor(filePath: string, eventCount: number, finalChecksum: string | null): Promise<void> {
  const details = await stat(filePath, { bigint: true });
  eventCursors.set(cursorKey(filePath), { size: details.size, mtimeNs: details.mtimeNs, eventCount, finalChecksum });
}

/** Append a validated event with a checksum chain and durable newline commit marker. */
export async function appendGenerationRunEvent(
  rootDirectory: string,
  projectId: string,
  eventInput: GenerationEvent
): Promise<AppendedGenerationRunEvent> {
  assertProjectId(projectId);
  const parsed = generationEventSchema.safeParse(eventInput);
  if (!parsed.success) fail('EVENT_INVALID', `Event schema validation failed: ${parsed.error.issues[0]?.message ?? 'invalid event'}`);
  const event = parsed.data;
  const runDirectory = await resolveRunDirectory(rootDirectory, projectId, event.runId, true);
  return withRunLock(runDirectory, async () => {
    const filePath = eventLogPath(runDirectory);
    const cursor = eventCursors.get(cursorKey(filePath));
    let state: EventLogState;
    if (await eventCursorMatches(filePath, cursor)) {
      state = { events: [], checksums: [], validBytes: Number(cursor!.size), ignoredTailBytes: 0, finalChecksum: cursor!.finalChecksum };
      if (event.seq !== cursor!.eventCount + 1) fail('EVENT_SEQUENCE_INVALID', `Expected event sequence ${cursor!.eventCount + 1}, received ${event.seq}`);
      if (cursor!.eventCount >= MAX_EVENTS) fail('EVENT_LIMIT', `A run may retain at most ${MAX_EVENTS} events`);
    } else {
      state = await parseEventLog(filePath, event.runId);
      if (event.seq !== state.events.length + 1) fail('EVENT_SEQUENCE_INVALID', `Expected event sequence ${state.events.length + 1}, received ${event.seq}`);
      if (state.events.length >= MAX_EVENTS) fail('EVENT_LIMIT', `A run may retain at most ${MAX_EVENTS} events`);
    }
    const previousChecksum = state.finalChecksum;
    const envelope = eventEnvelope(event, previousChecksum);
    const line = Buffer.concat([encodeRecord(envelope, 'generation run event'), Buffer.from('\n')]);
    if (line.byteLength > MAX_RECORD_BYTES) fail('EVENT_RECORD_TOO_LARGE', `Event record exceeds ${MAX_RECORD_BYTES} bytes`);
    if (state.validBytes + line.byteLength > MAX_EVENT_LOG_BYTES) fail('EVENT_LOG_TOO_LARGE', `Event log would exceed ${MAX_EVENT_LOG_BYTES} bytes`);
    const existing = await ensureRegularTarget(filePath);
    const currentRunBytes = await measureRunBytes(runDirectory);
    const previousEventFileBytes = existing ? Number(existing.size) : 0;
    if (currentRunBytes - previousEventFileBytes + state.validBytes + line.byteLength > MAX_RUN_BYTES) fail('RUN_TOO_LARGE', `Run storage would exceed ${MAX_RUN_BYTES} bytes`);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = existing
      ? await open(filePath, fsConstants.O_RDWR | noFollow)
      : await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow, 0o600);
    try {
      if (state.ignoredTailBytes > 0) {
        await handle.truncate(state.validBytes);
        await handle.sync();
      }
      const offset = state.ignoredTailBytes > 0 ? state.validBytes : previousEventFileBytes;
      let written = 0;
      while (written < line.byteLength) {
        const result = await handle.write(line, written, line.byteLength - written, offset + written);
        if (result.bytesWritten < 1) fail('EVENT_WRITE_FAILED', 'Event append stopped before the complete record was written');
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(runDirectory);
    const checksum = envelope.checksum;
    await cacheEventCursor(filePath, event.seq, checksum);
    return { eventPath: filePath, eventSeq: event.seq, checksum };
  });
}

/** Read and validate a contiguous event history; only an unterminated tail is ignored. */
export async function readGenerationRunEvents(
  rootDirectory: string,
  projectId: string,
  runId: string,
  afterSeq = 0
): Promise<ReadGenerationRunEventsResult> {
  assertId(runId, 'Run ID');
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail('INVALID_EVENT_CURSOR', 'Event cursor must be a non-negative safe integer');
  const runDirectory = await resolveRunDirectory(rootDirectory, projectId, runId, false);
  const filePath = eventLogPath(runDirectory);
  const state = await parseEventLog(filePath, runId);
  if (state.ignoredTailBytes === 0) await cacheEventCursor(filePath, state.events.length, state.finalChecksum);
  return { events: state.events.filter((event) => event.seq > afterSeq), ignoredTailBytes: state.ignoredTailBytes, validBytes: state.validBytes };
}

const allowedAttributes: Record<string, ReadonlySet<string>> = {
  svg: new Set(['xmlns', 'width', 'height', 'viewBox', 'role', 'aria-label']),
  title: new Set(),
  g: new Set(['data-node-id', 'opacity', 'stroke', 'stroke-width']),
  rect: new Set(['data-node-id', 'x', 'y', 'width', 'height', 'rx', 'fill', 'opacity', 'stroke', 'stroke-width']),
  ellipse: new Set(['data-node-id', 'cx', 'cy', 'rx', 'ry', 'fill', 'opacity', 'stroke', 'stroke-width']),
  text: new Set(['data-node-id', 'x', 'y', 'fill', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'opacity', 'stroke', 'stroke-width']),
  tspan: new Set(['x', 'dy'])
};

function isXml10CodePoint(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || codePoint >= 0x20 && codePoint <= 0xd7ff
    || codePoint >= 0xe000 && codePoint <= 0xfffd
    || codePoint >= 0x10000 && codePoint <= 0x10ffff;
}

function validateXmlText(value: string): boolean {
  for (const character of value) if (!isXml10CodePoint(character.codePointAt(0)!)) return false;
  return true;
}

function decodeXmlEntities(value: string): string {
  if (/(?:^|[^&])&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6});)/.test(value)) fail('UNSAFE_SVG', 'SVG contains an unsupported or malformed entity');
  const decoded = value.replace(/&(?:amp|lt|gt|quot|apos|#([0-9]{1,7})|#x([0-9a-fA-F]{1,6}));/g, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const point = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
    if (!isXml10CodePoint(point)) fail('UNSAFE_SVG', 'SVG contains an invalid XML character reference');
    return String.fromCodePoint(point);
  });
  if (!validateXmlText(decoded)) fail('UNSAFE_SVG', 'SVG contains characters that are not allowed in XML 1.0');
  return decoded;
}

function validateAttributeValue(name: string, value: string): void {
  if (['width', 'height'].includes(name) && !/^[1-9][0-9]{0,4}$/.test(value)) fail('UNSAFE_SVG', `SVG ${name} must be a positive integer`);
  if (['x', 'y', 'cx', 'cy', 'rx', 'ry', 'viewBox', 'font-size', 'stroke-width', 'rx', 'dy'].includes(name)) {
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:\s+-?(?:\d+(?:\.\d*)?|\.\d+)){0,3}$/.test(value) || !value.split(/\s+/).every((part) => Number.isFinite(Number(part)))) fail('UNSAFE_SVG', `SVG ${name} contains an invalid numeric value`);
  }
  if (name === 'opacity' && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value))) fail('UNSAFE_SVG', 'SVG opacity is invalid');
  if (['fill', 'stroke'].includes(name) && value !== 'none' && !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) fail('UNSAFE_SVG', `SVG ${name} must be a solid hex color or none`);
  if (name === 'font-weight' && !/^(?:[1-8]00|900)$/.test(value)) fail('UNSAFE_SVG', 'SVG font-weight is invalid');
  if (name === 'text-anchor' && !['start', 'middle', 'end'].includes(value)) fail('UNSAFE_SVG', 'SVG text-anchor is invalid');
  if (name === 'role' && value !== 'img') fail('UNSAFE_SVG', 'SVG role is unsupported');
  if (name === 'xmlns' && value !== SVG_NAMESPACE) fail('UNSAFE_SVG', 'SVG namespace is unsupported');
  if (name === 'data-node-id') assertId(value, 'SVG node ID');
}

/**
 * Parse a small renderer-compatible SVG subset. It rejects all non-allowlisted
 * elements/attributes, DTDs, comments, styles, links, scripts and external refs.
 */
function validateSafeRendererSvg(svg: string, expectedWidth: number, expectedHeight: number, expectedNodeIds: readonly string[]): void {
  if (!svg || Buffer.byteLength(svg, 'utf8') > MAX_EVIDENCE_BYTES || !validateXmlText(svg)) fail('UNSAFE_SVG', 'SVG is empty, too large, or contains illegal XML characters');
  const stack: string[] = [];
  const foundNodeIds = new Set<string>();
  let rootSeen = false;
  let rootClosed = false;
  let tokens = 0;
  let index = 0;
  const allowedChildren: Record<string, ReadonlySet<string>> = {
    svg: new Set(['title', 'g', 'rect', 'ellipse', 'text']),
    g: new Set(['g', 'rect', 'ellipse', 'text']),
    text: new Set(['tspan']),
    title: new Set(), rect: new Set(), ellipse: new Set(), tspan: new Set()
  };
  while (index < svg.length) {
    if (svg[index] !== '<') {
      const next = svg.indexOf('<', index);
      const end = next < 0 ? svg.length : next;
      const rawText = svg.slice(index, end);
      if (stack.length === 0 && rawText.trim() !== '') fail('UNSAFE_SVG', 'SVG has text outside its root element');
      if (stack.at(-1) === 'rect' || stack.at(-1) === 'ellipse' || stack.at(-1) === 'g' || stack.at(-1) === 'svg') {
        if (rawText.trim() !== '') fail('UNSAFE_SVG', 'SVG has text in a non-text element');
      }
      if (rawText.includes(']]>')) fail('UNSAFE_SVG', 'SVG contains invalid XML text');
      decodeXmlEntities(rawText);
      index = end;
      continue;
    }
    if (++tokens > 200_000) fail('UNSAFE_SVG', 'SVG exceeds the element limit');
    if (svg.startsWith('<!--', index) || svg.startsWith('<!', index) || svg.startsWith('<?', index)) fail('UNSAFE_SVG', 'SVG declarations and comments are not allowed');
    if (svg.startsWith('</', index)) {
      index += 2;
      const start = index;
      while (index < svg.length && /[A-Za-z0-9:_-]/.test(svg[index]!)) index++;
      const tag = svg.slice(start, index);
      while (/\s/.test(svg[index] ?? '')) index++;
      if (svg[index] !== '>' || !tag || stack.at(-1) !== tag) fail('UNSAFE_SVG', 'SVG closing tags are mismatched');
      stack.pop();
      index++;
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    index++;
    const nameStart = index;
    while (index < svg.length && /[A-Za-z0-9:_-]/.test(svg[index]!)) index++;
    const tag = svg.slice(nameStart, index);
    if (!tag || !Object.hasOwn(allowedAttributes, tag)) fail('UNSAFE_SVG', `SVG element ${tag || '<empty>'} is not allowed`);
    if (!stack.length) {
      if (rootSeen || rootClosed || tag !== 'svg') fail('UNSAFE_SVG', 'SVG must have exactly one svg root element');
      rootSeen = true;
    } else if (!allowedChildren[stack.at(-1)!]?.has(tag)) fail('UNSAFE_SVG', `SVG ${tag} cannot be nested in ${stack.at(-1)}`);
    const attributes = new Map<string, string>();
    let selfClosing = false;
    while (index < svg.length) {
      while (/\s/.test(svg[index] ?? '')) index++;
      if (svg.startsWith('/>', index)) { selfClosing = true; index += 2; break; }
      if (svg[index] === '>') { index++; break; }
      const attrStart = index;
      while (index < svg.length && /[A-Za-z0-9:_-]/.test(svg[index]!)) index++;
      const attr = svg.slice(attrStart, index);
      if (!attr || !allowedAttributes[tag]!.has(attr) || attributes.has(attr)) fail('UNSAFE_SVG', `SVG attribute ${attr || '<empty>'} is not allowed on ${tag}`);
      while (/\s/.test(svg[index] ?? '')) index++;
      if (svg[index] !== '=') fail('UNSAFE_SVG', `SVG attribute ${attr} has no value`);
      index++;
      while (/\s/.test(svg[index] ?? '')) index++;
      const quote = svg[index];
      if (quote !== '"' && quote !== "'") fail('UNSAFE_SVG', `SVG attribute ${attr} must be quoted`);
      index++;
      const valueStart = index;
      while (index < svg.length && svg[index] !== quote) {
        if (svg[index] === '<') fail('UNSAFE_SVG', 'SVG attributes cannot contain raw less-than characters');
        index++;
      }
      if (index >= svg.length) fail('UNSAFE_SVG', `SVG attribute ${attr} is unterminated`);
      const value = decodeXmlEntities(svg.slice(valueStart, index));
      index++;
      validateAttributeValue(attr, value);
      attributes.set(attr, value);
    }
    if (index > svg.length) fail('UNSAFE_SVG', 'SVG tag is unterminated');
    if (tag === 'svg') {
      if (attributes.get('xmlns') !== SVG_NAMESPACE || attributes.get('width') !== String(expectedWidth) || attributes.get('height') !== String(expectedHeight)) fail('EVIDENCE_MISMATCH', 'SVG root dimensions or namespace do not match evidence metadata');
      if (!attributes.has('viewBox')) fail('UNSAFE_SVG', 'SVG viewBox is required');
    }
    const nodeId = attributes.get('data-node-id');
    if (nodeId) {
      if (foundNodeIds.has(nodeId)) fail('UNSAFE_SVG', 'SVG contains duplicate node IDs');
      foundNodeIds.add(nodeId);
    }
    if (['rect', 'ellipse'].includes(tag) && !selfClosing) fail('UNSAFE_SVG', `${tag} elements must be empty`);
    if (selfClosing) {
      if (tag === 'svg') rootClosed = true;
    } else stack.push(tag);
  }
  if (!rootSeen || !rootClosed || stack.length) fail('UNSAFE_SVG', 'SVG document is incomplete');
  const expected = new Set(expectedNodeIds);
  if (expected.size !== expectedNodeIds.length || expected.size !== foundNodeIds.size || [...expected].some((id) => !foundNodeIds.has(id))) fail('EVIDENCE_MISMATCH', 'SVG node IDs do not match evidence metadata');
}

function evidenceEnvelope(evidence: ScreenshotEvidenceContent['evidence']): StoredEvidence {
  const body = { kind: 'screenshot-evidence' as const, formatVersion: 1 as const, evidence };
  return { ...body, checksum: sha256(canonicalJson(body, 'screenshot evidence').text) };
}

function parseEvidence(value: unknown, expected: { projectId: string; runId: string; evidenceId: string }): StoredEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EVIDENCE_INVALID', 'Evidence metadata must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['kind', 'formatVersion', 'evidence', 'checksum'].includes(key))) fail('EVIDENCE_INVALID', 'Evidence metadata has unknown fields');
  if (raw.kind !== 'screenshot-evidence' || raw.formatVersion !== 1 || typeof raw.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(raw.checksum)) fail('EVIDENCE_INVALID', 'Evidence metadata envelope is invalid');
  const parsed = screenshotEvidenceContentSchema.shape.evidence.safeParse(raw.evidence);
  if (!parsed.success) fail('EVIDENCE_INVALID', `Evidence schema validation failed: ${parsed.error.issues[0]?.message ?? 'invalid evidence'}`);
  if (parsed.data.runId !== expected.runId || parsed.data.evidenceId !== expected.evidenceId) fail('EVIDENCE_IDENTITY_MISMATCH', 'Evidence identity does not match its storage path');
  const body = { kind: 'screenshot-evidence' as const, formatVersion: 1 as const, evidence: parsed.data };
  if (sha256(canonicalJson(body, 'screenshot evidence').text) !== raw.checksum) fail('EVIDENCE_HASH_MISMATCH', 'Evidence metadata checksum is invalid');
  return { ...body, checksum: raw.checksum };
}

/** Save safe SVG evidence and its hash-bound metadata under the fixed project/run/evidence IDs. */
export async function saveScreenshotEvidence(
  rootDirectory: string,
  projectId: string,
  contentInput: ScreenshotEvidenceContent
): Promise<SavedScreenshotEvidence> {
  const parsed = screenshotEvidenceContentSchema.safeParse(contentInput);
  if (!parsed.success) fail('EVIDENCE_INVALID', `Evidence schema validation failed: ${parsed.error.issues[0]?.message ?? 'invalid evidence'}`);
  const content = parsed.data;
  assertProjectId(projectId);
  const { evidence, previewSvg } = content;
  if (evidence.imageHash !== sha256(previewSvg)) fail('EVIDENCE_HASH_MISMATCH', 'Evidence image hash does not match SVG bytes');
  validateSafeRendererSvg(previewSvg, evidence.width, evidence.height, evidence.nodeIds);
  const runDirectory = await resolveRunDirectory(rootDirectory, projectId, evidence.runId, true);
  return withRunLock(runDirectory, async () => {
    const evidenceDirectory = await resolveChildDirectory(runDirectory, 'evidence', true);
    const svgPath = path.join(evidenceDirectory, `${evidence.evidenceId}.svg`);
    const metadataPath = path.join(evidenceDirectory, `${evidence.evidenceId}.json`);
    const svgBytes = Buffer.from(previewSvg, 'utf8');
    const metadataBytes = encodeRecord(evidenceEnvelope(evidence), 'screenshot evidence metadata');
    const existingSvg = await ensureRegularTarget(svgPath);
    const existingMetadata = await ensureRegularTarget(metadataPath);
    const currentRunBytes = await measureRunBytes(runDirectory);
    const additional = (existingSvg ? 0 : svgBytes.byteLength) + (existingMetadata ? 0 : metadataBytes.byteLength);
    if (currentRunBytes + additional > MAX_RUN_BYTES) fail('RUN_TOO_LARGE', `Run storage would exceed ${MAX_RUN_BYTES} bytes`);
    await createImmutableFile(svgPath, svgBytes);
    try { await createImmutableFile(metadataPath, metadataBytes); }
    catch (error) {
      // An SVG without its hash-bound metadata is an orphan and is ignored by reads.
      throw error;
    }
    return { evidenceId: evidence.evidenceId, svgPath, metadataPath, imageHash: evidence.imageHash };
  });
}

/** Load evidence only when its metadata, content hash, IDs and safe SVG subset agree. */
export async function readScreenshotEvidence(
  rootDirectory: string,
  projectId: string,
  runId: string,
  evidenceId: string
): Promise<ScreenshotEvidenceContent> {
  assertId(evidenceId, 'Evidence ID');
  const runDirectory = await resolveRunDirectory(rootDirectory, projectId, runId, false);
  const evidenceDirectory = await resolveChildDirectory(runDirectory, 'evidence', false);
  const svgPath = path.join(evidenceDirectory, `${evidenceId}.svg`);
  const metadataPath = path.join(evidenceDirectory, `${evidenceId}.json`);
  const metadataBytes = await readRegularFile(metadataPath, MAX_RECORD_BYTES, 'RUN_RECORD_TOO_LARGE');
  let metadataInput: unknown;
  try { metadataInput = JSON.parse(metadataBytes.toString('utf8')) as unknown; }
  catch { fail('EVIDENCE_INVALID', 'Evidence metadata is not valid JSON'); }
  const stored = parseEvidence(metadataInput, { projectId, runId, evidenceId });
  const svgBytes = await readRegularFile(svgPath, MAX_EVIDENCE_BYTES, 'EVIDENCE_TOO_LARGE');
  const previewSvg = svgBytes.toString('utf8');
  if (sha256(svgBytes) !== stored.evidence.imageHash) fail('EVIDENCE_HASH_MISMATCH', 'Evidence SVG hash does not match metadata');
  validateSafeRendererSvg(previewSvg, stored.evidence.width, stored.evidence.height, stored.evidence.nodeIds);
  const content = { evidence: stored.evidence, previewSvg };
  const parsed = screenshotEvidenceContentSchema.safeParse(content);
  if (!parsed.success) fail('EVIDENCE_INVALID', 'Stored screenshot evidence failed schema validation');
  return parsed.data;
}

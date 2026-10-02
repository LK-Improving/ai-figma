import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assetMetaSchema, validateDesignDocument, documentIdSchema, nodeIdSchema, type DesignDocument, type DesignNode } from '@miaoma/design-schema';

const projectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const documentCommandIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const exportIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const MAX_COMMANDS_PER_COMMIT = 1_000;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_PROJECT_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_EXPORT_ASSETS_BYTES = MAX_PROJECT_ASSET_BYTES;
export const MAX_PROJECT_ASSET_PIXELS = 32 * 1024 * 1024;

export type DesignCommandOrigin = 'human' | 'agent' | 'import';

/**
 * A durable command transaction. `document` is the fully validated post-commit
 * document, allowing recovery without importing editor-core or re-running
 * command handlers. Callers must calculate it without mutating live state,
 * await appendDesignJournalCommit, and only then publish the in-memory commit.
 */
export type DesignJournalCommit<TCommand = unknown, TMetadata = unknown> = {
  commandId: string;
  baseRevision: number;
  nextRevision: number;
  commands: readonly TCommand[];
  inverse?: unknown;
  origin: DesignCommandOrigin;
  metadata?: TMetadata;
  document: DesignDocument;
};

export type JournalAppendResult = {
  journalPath: string;
  revision: number;
  appended: boolean;
  checksum: string;
};

export type SavedSnapshot = { snapshotPath: string; documentPath: string; revision: number };

export type RecoveryDiagnostic = {
  code: string;
  message: string;
  line?: number;
};

export type RecoveryResult = {
  document: DesignDocument;
  snapshotRevision: number;
  replayedCommits: number;
  ignoredTailBytes: number;
  diagnostics: RecoveryDiagnostic[];
};

export type PngExportMetadata = {
  documentId: string;
  documentRevision: number;
  pageId: string;
  nodeIds: readonly string[];
  width: number;
  height: number;
  scale: number;
  mimeType: 'image/png';
};

export type SavedProjectExport = {
  exportPath: string;
  documentPath: string;
  imagePath: string;
  manifestPath: string;
  sha256: string;
};

export type DesignAsset = DesignDocument['assets'][string];
export type ReadDesignAssetResult = { asset: DesignAsset; bytes: Uint8Array };
export type PortableProjectExport = { document: DesignDocument; assets: ReadDesignAssetResult[]; pageId: string; previewBytes: Uint8Array };
export type LocalDesignPackage = { document: DesignDocument; assets: ReadDesignAssetResult[] };

export class StoragePersistenceError extends Error {
  constructor(readonly code: string, message: string, readonly diagnostics?: readonly RecoveryDiagnostic[]) {
    super(message);
    this.name = 'StoragePersistenceError';
  }
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type JournalRecord = {
  kind: 'design-command-commit';
  formatVersion: 1;
  commandId: string;
  baseRevision: number;
  nextRevision: number;
  commands: JsonValue[];
  inverse?: JsonValue;
  origin: DesignCommandOrigin;
  metadata?: JsonValue;
  document: DesignDocument;
  committed: true;
  checksum: string;
};

type ReadJournalResult = {
  records: JournalRecord[];
  validBytes: number;
  ignoredTailBytes: number;
  diagnostics: RecoveryDiagnostic[];
};

const journalLocks = new Map<string, Promise<void>>();

function canonicalJson(value: unknown, label: string): { value: JsonValue; text: string } {
  const active = new WeakSet<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > 64 || ++count > 100_000) throw new StoragePersistenceError('JSON_LIMIT', `${label} exceeds the JSON complexity limit`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new StoragePersistenceError('INVALID_JSON', `${label} contains a non-finite number`);
      return item;
    }
    if (!item || typeof item !== 'object') throw new StoragePersistenceError('INVALID_JSON', `${label} must contain JSON values only`);
    if (active.has(item)) throw new StoragePersistenceError('INVALID_JSON', `${label} cannot contain cycles`);
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const ownKeys = Reflect.ownKeys(item);
        if (ownKeys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) throw new StoragePersistenceError('INVALID_JSON', `${label} arrays cannot contain custom keys`);
        const output: JsonValue[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new StoragePersistenceError('INVALID_JSON', `${label} arrays cannot contain holes or accessors`);
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new StoragePersistenceError('INVALID_JSON', `${label} must contain plain JSON objects`);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) throw new StoragePersistenceError('INVALID_JSON', `${label} cannot contain symbol keys`);
      const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor) || !descriptor.enumerable) throw new StoragePersistenceError('INVALID_JSON', `${label} cannot contain accessors or hidden fields`);
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(item);
    }
  };
  const normalized = visit(value, 0);
  const text = JSON.stringify(normalized);
  return { value: normalized, text };
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateDocument(input: unknown, expectedId?: string): DesignDocument {
  const checked = validateDesignDocument(input);
  if (!checked.success) throw new StoragePersistenceError('INVALID_DOCUMENT', `Document failed validation: ${checked.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
  if (expectedId !== undefined && checked.data.documentId !== expectedId) throw new StoragePersistenceError('DOCUMENT_ID_MISMATCH', 'The document ID does not match its storage path');
  return checked.data;
}

function validateProjectId(projectId: string): void {
  if (!projectIdPattern.test(projectId)) throw new StoragePersistenceError('INVALID_PROJECT_ID', 'Invalid project ID');
}

function validateDocumentId(documentId: string): void {
  if (!documentIdSchema.safeParse(documentId).success) throw new StoragePersistenceError('INVALID_DOCUMENT_ID', 'Invalid document ID');
}

function validateCommandId(commandId: string): void {
  if (!documentCommandIdPattern.test(commandId)) throw new StoragePersistenceError('INVALID_COMMAND_ID', 'Invalid command ID');
}

async function resolveProjectDirectory(rootDirectory: string, projectId: string, create: boolean): Promise<string> {
  validateProjectId(projectId);
  const absoluteRoot = path.resolve(rootDirectory);
  if (create) await mkdir(absoluteRoot, { recursive: true });
  const actualRoot = await realpath(absoluteRoot);
  const projectPath = path.join(actualRoot, projectId);
  if (create) await mkdir(projectPath, { recursive: true });
  const projectStats = await lstat(projectPath);
  if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) throw new StoragePersistenceError('UNSAFE_PATH', 'Project path cannot be a symbolic link and must be a directory');
  const actualProject = await realpath(projectPath);
  if (path.dirname(actualProject) !== actualRoot) throw new StoragePersistenceError('UNSAFE_PATH', 'Project directory escaped the selected workspace');
  return actualProject;
}

async function resolveChildDirectory(parent: string, childName: string, create: boolean): Promise<string> {
  const childPath = path.join(parent, childName);
  if (create) await mkdir(childPath, { recursive: true });
  const childStats = await lstat(childPath);
  if (childStats.isSymbolicLink() || !childStats.isDirectory()) throw new StoragePersistenceError('UNSAFE_PATH', 'Storage paths cannot use symbolic links and must be directories');
  const actualChild = await realpath(childPath);
  if (path.dirname(actualChild) !== parent) throw new StoragePersistenceError('UNSAFE_PATH', 'Storage directory escaped its project');
  return actualChild;
}

async function resolveDocumentDirectory(rootDirectory: string, projectId: string, documentId: string, create: boolean): Promise<{ projectDirectory: string; documentDirectory: string }> {
  validateDocumentId(documentId);
  const projectDirectory = await resolveProjectDirectory(rootDirectory, projectId, create);
  const documentDirectory = await resolveChildDirectory(projectDirectory, documentId, create);
  return { projectDirectory, documentDirectory };
}

async function assertRegularFile(filePath: string): Promise<void> {
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_PATH', `Expected a regular file: ${path.basename(filePath)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
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
  } finally {
    await handle?.close();
  }
}

async function atomicReplaceFile(filePath: string, content: string | Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await assertRegularFile(filePath);
  const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_PATH', `Expected a regular file: ${path.basename(filePath)}`);
  if (details.size > MAX_RECORD_BYTES) throw new StoragePersistenceError('FILE_TOO_LARGE', `Stored file exceeds ${MAX_RECORD_BYTES} bytes`);
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function recordWithoutChecksum(record: Omit<JournalRecord, 'checksum'> | JournalRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    formatVersion: record.formatVersion,
    commandId: record.commandId,
    baseRevision: record.baseRevision,
    nextRevision: record.nextRevision,
    commands: record.commands,
    ...(record.inverse === undefined ? {} : { inverse: record.inverse }),
    origin: record.origin,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    document: record.document,
    committed: record.committed
  };
}

function parseJournalRecord(value: unknown, line: number, expectedDocumentId: string): JournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal line must be a JSON object');
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'formatVersion', 'commandId', 'baseRevision', 'nextRevision', 'commands', 'inverse', 'origin', 'metadata', 'document', 'committed', 'checksum']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal line contains unknown fields');
  if (raw.kind !== 'design-command-commit' || raw.formatVersion !== 1 || raw.committed !== true || typeof raw.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(raw.checksum)) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal line is not a committed v1 record');
  if (typeof raw.commandId !== 'string' || !documentCommandIdPattern.test(raw.commandId)) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal command ID is invalid');
  if (!Number.isSafeInteger(raw.baseRevision) || !Number.isSafeInteger(raw.nextRevision) || (raw.baseRevision as number) < 0 || raw.nextRevision !== (raw.baseRevision as number) + 1) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal revisions are invalid');
  if (!Array.isArray(raw.commands) || raw.commands.length < 1 || raw.commands.length > MAX_COMMANDS_PER_COMMIT) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal commands are invalid');
  if (!['human', 'agent', 'import'].includes(String(raw.origin))) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal origin is invalid');
  const document = validateDocument(raw.document, expectedDocumentId);
  if (document.revision !== raw.nextRevision) throw new StoragePersistenceError('JOURNAL_INVALID_RECORD', 'Journal document revision does not match the commit');
  const payload = recordWithoutChecksum(raw as unknown as JournalRecord);
  const canonical = canonicalJson(payload, `journal line ${line}`);
  if (hashText(canonical.text) !== raw.checksum) throw new StoragePersistenceError('JOURNAL_CHECKSUM_MISMATCH', 'Journal checksum does not match the record');
  const normalized = canonicalJson(raw, `journal line ${line}`).value as unknown as JournalRecord;
  return normalized;
}

async function readJournal(journalPath: string, documentId: string): Promise<ReadJournalResult> {
  const records: JournalRecord[] = [];
  const seenCommandIds = new Set<string>();
  const diagnostics: RecoveryDiagnostic[] = [];
  let validBytes = 0;
  let ignoredTailBytes = 0;
  try {
    await assertRegularFile(journalPath);
    const details = await stat(journalPath);
    if (details.size > MAX_JOURNAL_BYTES) throw new StoragePersistenceError('JOURNAL_TOO_LARGE', `Journal exceeds ${MAX_JOURNAL_BYTES} bytes; create a snapshot/checkpoint before continuing`);
    const bytes = await readFile(journalPath);
    const finalNewline = bytes.lastIndexOf(0x0a);
    const completeLength = finalNewline + 1;
    ignoredTailBytes = bytes.length - completeLength;
    let start = 0;
    let line = 0;
    while (start < completeLength) {
      const end = bytes.indexOf(0x0a, start);
      if (end < 0 || end >= completeLength) break;
      line++;
      const length = end - start;
      if (length < 1 || length > MAX_RECORD_BYTES) {
        diagnostics.push({ code: 'JOURNAL_INVALID_RECORD', message: 'Journal line is empty or exceeds its size limit', line });
        break;
      }
      try {
        const parsed = JSON.parse(bytes.subarray(start, end).toString('utf8')) as unknown;
        const record = parseJournalRecord(parsed, line, documentId);
        const previous = records.at(-1);
        if (previous && record.baseRevision !== previous.nextRevision) throw new StoragePersistenceError('JOURNAL_REVISION_GAP', `Expected base revision ${previous.nextRevision}, got ${record.baseRevision}`);
        if (seenCommandIds.has(record.commandId)) throw new StoragePersistenceError('DUPLICATE_COMMAND_ID', 'Journal contains a duplicate command ID');
        seenCommandIds.add(record.commandId);
        records.push(record);
        validBytes = end + 1;
      } catch (error) {
        diagnostics.push({ code: error instanceof StoragePersistenceError ? error.code : 'JOURNAL_INVALID_RECORD', message: error instanceof Error ? error.message : 'Unable to parse journal record', line });
        break;
      }
      start = end + 1;
    }
    return { records, validBytes, ignoredTailBytes, diagnostics };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, validBytes: 0, ignoredTailBytes: 0, diagnostics };
    throw error;
  }
}

type SnapshotCandidate = { document: DesignDocument; path: string; role: 'snapshot' | 'mirror' };

async function readSnapshotCandidates(rootDirectory: string, projectId: string, documentId: string): Promise<{ projectDirectory: string; candidates: SnapshotCandidate[]; diagnostics: RecoveryDiagnostic[] }> {
  const projectDirectory = await resolveProjectDirectory(rootDirectory, projectId, false);
  const candidates: SnapshotCandidate[] = [];
  const diagnostics: RecoveryDiagnostic[] = [];
  const paths: Array<{ filePath: string; role: SnapshotCandidate['role'] }> = [];
  try {
    const snapshotsDirectory = await resolveChildDirectory(projectDirectory, 'snapshots', false);
    paths.push({ filePath: path.join(snapshotsDirectory, `${documentId}.json`), role: 'snapshot' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ code: 'UNSAFE_PATH', message: `Snapshot directory could not be used: ${error instanceof Error ? error.message : 'unknown error'}` });
  }
  try {
    const documentDirectory = await resolveChildDirectory(projectDirectory, documentId, false);
    paths.push({ filePath: path.join(documentDirectory, 'design.json'), role: 'mirror' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ code: 'UNSAFE_PATH', message: `S0 mirror directory could not be used: ${error instanceof Error ? error.message : 'unknown error'}` });
  }
  for (const candidate of paths) {
    try {
      const input = await readJsonFile(candidate.filePath);
      candidates.push({ document: validateDocument(input, documentId), path: candidate.filePath, role: candidate.role });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      diagnostics.push({ code: error instanceof StoragePersistenceError ? error.code : 'SNAPSHOT_INVALID', message: `${candidate.role} snapshot could not be used: ${error instanceof Error ? error.message : 'unknown error'}` });
    }
  }
  if (candidates.length === 2) {
    const [snapshot, mirror] = candidates;
    if (snapshot!.document.revision === mirror!.document.revision) {
      const left = canonicalJson(snapshot!.document, 'snapshot').text;
      const right = canonicalJson(mirror!.document, 'mirror').text;
      if (left !== right) diagnostics.push({ code: 'SNAPSHOT_DIVERGENCE', message: 'The snapshot and S0 mirror differ at the same revision; the canonical snapshot was selected' });
    }
  }
  return { projectDirectory, candidates, diagnostics };
}

async function withJournalLock<T>(journalPath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(journalPath).toLowerCase();
  const previous = journalLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  journalLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (journalLocks.get(key) === current) journalLocks.delete(key);
  }
}

/** Persist a command before its caller publishes the corresponding in-memory state. */
export async function appendDesignJournalCommit<TCommand = unknown, TMetadata = unknown>(
  rootDirectory: string,
  projectId: string,
  commit: DesignJournalCommit<TCommand, TMetadata>
): Promise<JournalAppendResult> {
  validateCommandId(commit.commandId);
  if (!Number.isSafeInteger(commit.baseRevision) || !Number.isSafeInteger(commit.nextRevision) || commit.baseRevision < 0 || commit.nextRevision !== commit.baseRevision + 1) throw new StoragePersistenceError('INVALID_REVISION', 'A command commit must advance exactly one revision');
  if (!['human', 'agent', 'import'].includes(commit.origin)) throw new StoragePersistenceError('INVALID_ORIGIN', 'Invalid command origin');
  if (!Array.isArray(commit.commands) || commit.commands.length < 1 || commit.commands.length > MAX_COMMANDS_PER_COMMIT) throw new StoragePersistenceError('INVALID_COMMANDS', `A commit must contain 1–${MAX_COMMANDS_PER_COMMIT} commands`);
  const document = validateDocument(commit.document);
  if (document.revision !== commit.nextRevision) throw new StoragePersistenceError('REVISION_MISMATCH', 'Post-commit document revision does not match nextRevision');
  const { projectDirectory } = await resolveDocumentDirectory(rootDirectory, projectId, document.documentId, true);
  const journalDirectory = await resolveChildDirectory(projectDirectory, 'journal', true);
  const journalPath = path.join(journalDirectory, `${document.documentId}.jsonl`);

  const serialized = canonicalJson({
    kind: 'design-command-commit', formatVersion: 1, commandId: commit.commandId,
    baseRevision: commit.baseRevision, nextRevision: commit.nextRevision,
    commands: commit.commands, ...(commit.inverse === undefined ? {} : { inverse: commit.inverse }),
    origin: commit.origin, ...(commit.metadata === undefined ? {} : { metadata: commit.metadata }),
    document, committed: true
  }, 'command commit');
  if (Buffer.byteLength(serialized.text, 'utf8') > MAX_RECORD_BYTES) throw new StoragePersistenceError('RECORD_TOO_LARGE', `Command record exceeds ${MAX_RECORD_BYTES} bytes`);
  const checksum = hashText(serialized.text);
  const recordText = JSON.stringify({ ...(serialized.value as Record<string, JsonValue>), checksum });
  const line = Buffer.from(`${recordText}\n`, 'utf8');

  return withJournalLock(journalPath, async () => {
    const snapshots = await readSnapshotCandidates(rootDirectory, projectId, document.documentId);
    const snapshot = snapshots.candidates.sort((a, b) => b.document.revision - a.document.revision || (a.role === 'snapshot' ? -1 : 1))[0];
    if (!snapshot) throw new StoragePersistenceError('SNAPSHOT_NOT_FOUND', 'Save an initial snapshot before appending command commits');
    if (snapshots.diagnostics.some((item) => item.code === 'SNAPSHOT_DIVERGENCE')) throw new StoragePersistenceError('SNAPSHOT_DIVERGENCE', 'Cannot append while same-revision snapshots disagree');

    const journal = await readJournal(journalPath, document.documentId);
    if (journal.diagnostics.length) throw new StoragePersistenceError(journal.diagnostics[0]!.code, `Refusing to append to a corrupt journal at line ${journal.diagnostics[0]!.line ?? '?'}: ${journal.diagnostics[0]!.message}`);
    const duplicate = journal.records.find((item) => item.commandId === commit.commandId);
    if (duplicate) {
      if (duplicate.checksum === checksum) return { journalPath, revision: duplicate.nextRevision, appended: false, checksum };
      throw new StoragePersistenceError('DUPLICATE_COMMAND_ID', 'Command ID was already committed with different content');
    }
    const lastRecord = journal.records.at(-1);
    const durableRevision = Math.max(snapshot.document.revision, lastRecord?.nextRevision ?? 0);
    if (commit.baseRevision !== durableRevision) throw new StoragePersistenceError('REVISION_CONFLICT', `Expected base revision ${durableRevision}, received ${commit.baseRevision}`);
    const snapshotCommit = journal.records.find((item) => item.nextRevision === snapshot.document.revision);
    if (snapshotCommit) {
      const lastDocument = canonicalJson(snapshotCommit.document, 'journal document').text;
      const savedDocument = canonicalJson(snapshot.document, 'snapshot document').text;
      if (lastDocument !== savedDocument) throw new StoragePersistenceError('SNAPSHOT_JOURNAL_DIVERGENCE', 'The latest journal document differs from the snapshot at the same revision');
    }

    const existing = await lstat(journalPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new StoragePersistenceError('UNSAFE_PATH', 'Journal path must be a regular file');
    if (existing && existing.size - journal.ignoredTailBytes + line.length > MAX_JOURNAL_BYTES) throw new StoragePersistenceError('JOURNAL_TOO_LARGE', `Journal would exceed ${MAX_JOURNAL_BYTES} bytes; create a snapshot/checkpoint before continuing`);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = existing
      ? await open(journalPath, fsConstants.O_RDWR | noFollow)
      : await open(journalPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow, 0o600);
    try {
      if (journal.ignoredTailBytes > 0) {
        await handle.truncate(journal.validBytes);
        await handle.sync();
      }
      let written = 0;
      const appendOffset = journal.ignoredTailBytes > 0 ? journal.validBytes : (existing?.size ?? 0);
      while (written < line.length) {
        const result = await handle.write(line, written, line.length - written, appendOffset + written);
        if (result.bytesWritten < 1) throw new StoragePersistenceError('JOURNAL_WRITE_FAILED', 'Journal append stopped before the complete record was written');
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(journalDirectory);
    return { journalPath, revision: commit.nextRevision, appended: true, checksum };
  });
}

/** Atomically advance the canonical snapshot and refresh the legacy S0 design.json mirror. */
export async function saveDesignSnapshot(rootDirectory: string, projectId: string, input: DesignDocument): Promise<SavedSnapshot> {
  const document = validateDocument(input);
  const { projectDirectory, documentDirectory } = await resolveDocumentDirectory(rootDirectory, projectId, document.documentId, true);
  const snapshotsDirectory = await resolveChildDirectory(projectDirectory, 'snapshots', true);
  const snapshotPath = path.join(snapshotsDirectory, `${document.documentId}.json`);
  const documentPath = path.join(documentDirectory, 'design.json');
  const text = `${JSON.stringify(document, null, 2)}\n`;
  return withJournalLock(snapshotPath, async () => {
    const previous = await readSnapshotCandidates(rootDirectory, projectId, document.documentId);
    if (previous.diagnostics.some((item) => item.code === 'SNAPSHOT_DIVERGENCE')) throw new StoragePersistenceError('SNAPSHOT_DIVERGENCE', 'Cannot replace same-revision snapshots that disagree');
    const latest = previous.candidates.sort((a, b) => b.document.revision - a.document.revision)[0];
    if (latest && document.revision < latest.document.revision) throw new StoragePersistenceError('SNAPSHOT_ROLLBACK', 'A snapshot cannot move the document revision backwards');
    const candidateText = canonicalJson(document, 'new snapshot').text;
    if (latest && document.revision === latest.document.revision && canonicalJson(latest.document, 'existing snapshot').text !== candidateText) throw new StoragePersistenceError('SNAPSHOT_CONFLICT', 'A different document already exists at this revision');

    let journalDirectory: string | null = null;
    try { journalDirectory = await resolveChildDirectory(projectDirectory, 'journal', false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (journalDirectory) {
      const journal = await readJournal(path.join(journalDirectory, `${document.documentId}.jsonl`), document.documentId);
      const nonTailErrors = journal.diagnostics.filter((item) => item.code !== 'JOURNAL_INCOMPLETE_TAIL');
      if (nonTailErrors.length) throw new StoragePersistenceError(nonTailErrors[0]!.code, `Cannot snapshot a corrupt journal: ${nonTailErrors[0]!.message}`);
      const sameRevision = journal.records.find((item) => item.nextRevision === document.revision);
      if (sameRevision && canonicalJson(sameRevision.document, 'journal snapshot').text !== candidateText) throw new StoragePersistenceError('SNAPSHOT_JOURNAL_DIVERGENCE', 'Snapshot differs from the committed journal document at the same revision');
      const startsAtCandidate = journal.records[0]?.baseRevision === document.revision;
      if (journal.records.length > 0 && !sameRevision && !startsAtCandidate && (!latest || document.revision > latest.document.revision)) throw new StoragePersistenceError('SNAPSHOT_NOT_COMMITTED', 'The new snapshot revision is not present in the committed journal');
    }
    await atomicReplaceFile(snapshotPath, text);
    await atomicReplaceFile(documentPath, text);
    return { snapshotPath, documentPath, revision: document.revision };
  });
}

/**
 * Load the newest valid snapshot and recover contiguous, committed journal
 * records. Incomplete trailing bytes are ignored and left untouched. A missing
 * valid snapshot is an error; recoverable journal damage is returned as a
 * diagnostic alongside the last safe document.
 */
export async function loadRecoverableDesignDocument(rootDirectory: string, projectId: string, documentId: string): Promise<RecoveryResult> {
  validateDocumentId(documentId);
  let snapshotRead: Awaited<ReturnType<typeof readSnapshotCandidates>>;
  try {
    snapshotRead = await readSnapshotCandidates(rootDirectory, projectId, documentId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StoragePersistenceError('SNAPSHOT_NOT_FOUND', `No project snapshot exists for document ${documentId}`);
    throw error;
  }
  const { projectDirectory, candidates, diagnostics } = snapshotRead;
  const snapshot = candidates.sort((a, b) => b.document.revision - a.document.revision || (a.role === 'snapshot' ? -1 : 1))[0];
  if (!snapshot) {
    if (diagnostics.some((item) => item.code === 'UNSAFE_PATH')) throw new StoragePersistenceError('UNSAFE_PATH', `No safe snapshot path is available for document ${documentId}`, diagnostics);
    throw new StoragePersistenceError('SNAPSHOT_NOT_FOUND', `No valid snapshot exists for document ${documentId}`, diagnostics);
  }
  let document = snapshot.document;
  const snapshotRevision = document.revision;
  let journalPath: string;
  try { journalPath = path.join(await resolveChildDirectory(projectDirectory, 'journal', false), `${documentId}.jsonl`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { document, snapshotRevision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics };
    diagnostics.push({ code: 'UNSAFE_PATH', message: `Journal directory could not be used: ${error instanceof Error ? error.message : 'unknown error'}` });
    return { document, snapshotRevision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics };
  }
  let journal: ReadJournalResult;
  try {
    journal = await readJournal(journalPath, documentId);
  } catch (error) {
    diagnostics.push({ code: error instanceof StoragePersistenceError ? error.code : 'JOURNAL_READ_FAILED', message: error instanceof Error ? error.message : 'Unable to read the command journal' });
    return { document, snapshotRevision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics };
  }
  diagnostics.push(...journal.diagnostics);
  let replayedCommits = 0;
  const snapshotCommit = journal.records.find((record) => record.nextRevision === snapshotRevision);
  if (snapshotCommit && canonicalJson(snapshotCommit.document, 'journal snapshot').text !== canonicalJson(document, 'loaded snapshot').text) {
    diagnostics.push({ code: 'SNAPSHOT_JOURNAL_DIVERGENCE', message: `Snapshot and journal disagree at revision ${snapshotRevision}; journal replay stopped` });
    return { document, snapshotRevision, replayedCommits, ignoredTailBytes: journal.ignoredTailBytes, diagnostics };
  }
  for (const record of journal.records) {
    if (record.nextRevision <= document.revision) continue;
    if (record.baseRevision !== document.revision) {
      diagnostics.push({ code: 'JOURNAL_REVISION_GAP', message: `Recovery stopped at revision ${document.revision}; next commit expects ${record.baseRevision}` });
      break;
    }
    document = record.document;
    replayedCommits++;
  }
  if (journal.ignoredTailBytes > 0) diagnostics.push({ code: 'JOURNAL_INCOMPLETE_TAIL', message: `Ignored ${journal.ignoredTailBytes} trailing bytes without a newline` });
  return { document, snapshotRevision, replayedCommits, ignoredTailBytes: journal.ignoredTailBytes, diagnostics };
}

function pngCrc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 8 + 25 || !bytes.subarray(0, 8).equals(signature)) throw new StoragePersistenceError('INVALID_PNG', 'Export bytes do not contain a PNG signature and IHDR');
  let offset = 8;
  let width = 0, height = 0, sawHeader = false, sawData = false, sawEnd = false, chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > 10_000 || offset + 12 > bytes.length) throw new StoragePersistenceError('INVALID_PNG', 'PNG has a truncated or excessive chunk list');
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > MAX_EXPORT_BYTES || chunkEnd > bytes.length) throw new StoragePersistenceError('INVALID_PNG', 'PNG chunk length is invalid');
    const type = bytes.toString('ascii', typeStart, typeStart + 4);
    if (chunks === 1 && (type !== 'IHDR' || length !== 13)) throw new StoragePersistenceError('INVALID_PNG', 'PNG must begin with a 13-byte IHDR chunk');
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (pngCrc32(bytes, typeStart, dataEnd) !== expectedCrc) throw new StoragePersistenceError('INVALID_PNG', `PNG ${type} chunk checksum is invalid`);
    if (type === 'IHDR') {
      if (sawHeader) throw new StoragePersistenceError('INVALID_PNG', 'PNG contains more than one IHDR chunk');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      if (!width || !height || width > 4096 || height > 4096) throw new StoragePersistenceError('INVALID_PNG', 'PNG dimensions must be between 1 and 4096 pixels');
      sawHeader = true;
    } else if (type === 'IDAT') sawData = true;
    else if (type === 'IEND') {
      if (length !== 0 || !sawData) throw new StoragePersistenceError('INVALID_PNG', 'PNG IEND or image data is invalid');
      sawEnd = true;
      if (chunkEnd !== bytes.length) throw new StoragePersistenceError('INVALID_PNG', 'PNG contains data after IEND');
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new StoragePersistenceError('INVALID_PNG', 'PNG is incomplete');
  return { width, height };
}

export function getPngDimensions(inputBytes: Uint8Array): { width: number; height: number } {
  if (!(inputBytes instanceof Uint8Array)) throw new StoragePersistenceError('INVALID_PNG', 'PNG input must be a byte array');
  return inspectPng(Buffer.from(inputBytes));
}

export function accumulateProjectAssetPixels(currentPixels: number, dimensions: { width: number; height: number }): number {
  const nextPixels = currentPixels + dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(currentPixels) || currentPixels < 0 || !Number.isSafeInteger(nextPixels) || nextPixels > MAX_PROJECT_ASSET_PIXELS) {
    throw new StoragePersistenceError('ASSET_PIXEL_BUDGET_EXCEEDED', `Project assets exceed the ${MAX_PROJECT_ASSET_PIXELS.toLocaleString()} decoded-pixel limit`);
  }
  return nextPixels;
}

export function accumulateProjectAssetBytes(currentBytes: number, nextBytes: number): number {
  const totalBytes = currentBytes + nextBytes;
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0 || !Number.isSafeInteger(nextBytes) || nextBytes < 0 || !Number.isSafeInteger(totalBytes) || totalBytes > MAX_PROJECT_ASSET_BYTES) {
    throw new StoragePersistenceError('ASSET_BYTES_BUDGET_EXCEEDED', `Project assets exceed the ${MAX_PROJECT_ASSET_BYTES / (1024 * 1024)} MiB compressed-byte limit`);
  }
  return totalBytes;
}

async function readPortableFile(exportDirectory: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  const segments = relativePath.split('/');
  if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath) || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', 'Portable export contains an unsafe relative path');
  }
  const rootInfo = await lstat(exportDirectory).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', 'Portable export directory is missing or unsafe');
  const root = await realpath(exportDirectory);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    const info = await lstat(current).catch(() => null);
    const final = index === segments.length - 1;
    if (!info || info.isSymbolicLink() || (final ? !info.isFile() : !info.isDirectory())) {
      throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', `Portable export path is missing or unsafe: ${relativePath}`);
    }
  }
  const resolved = path.resolve(current);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', 'Portable export path escaped its package directory');
  const info = await stat(current);
  if (info.size > maxBytes) throw new StoragePersistenceError('EXPORT_PACKAGE_TOO_LARGE', `Portable export file exceeds ${maxBytes} bytes: ${relativePath}`);
  return readFile(current);
}

/** Load a local design.json and the verified PNG assets referenced beside it. */
export async function readLocalDesignPackage(documentPath: string): Promise<LocalDesignPackage> {
  const absolutePath = path.resolve(documentPath);
  let document: DesignDocument;
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) throw new StoragePersistenceError('UNSAFE_IMPORT_PATH', 'Selected design file is missing, unsafe, or too large');
    const input = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
    const validation = validateDesignDocument(input);
    if (!validation.success) throw new StoragePersistenceError('INVALID_DOCUMENT', `Imported design is invalid: ${validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
    document = validation.data;
  } catch (error) {
    if (error instanceof StoragePersistenceError) throw error;
    throw new StoragePersistenceError('INVALID_DESIGN_FILE', error instanceof Error ? error.message : 'Selected design file could not be read');
  }
  const directory = path.dirname(absolutePath);
  const assets: ReadDesignAssetResult[] = [];
  let totalAssetBytes = 0;
  let totalAssetPixels = 0;
  for (const [assetId, rawAsset] of Object.entries(document.assets)) {
    const asset = validateAssetMeta(rawAsset, assetId);
    if (asset.mimeType !== 'image/png') throw new StoragePersistenceError('UNSUPPORTED_IMPORT_ASSET', `Only PNG assets are supported in this milestone: ${assetId}`);
    totalAssetBytes += asset.byteSize;
    if (totalAssetBytes > MAX_EXPORT_ASSETS_BYTES) throw new StoragePersistenceError('EXPORT_ASSETS_TOO_LARGE', 'Imported design assets exceed the 100 MiB package limit');
    const bytes = await readPortableFile(directory, asset.relativePath, MAX_ASSET_BYTES);
    if (bytes.length !== asset.byteSize || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new StoragePersistenceError('ASSET_HASH_MISMATCH', `Imported asset failed hash validation: ${assetId}`);
    totalAssetPixels = accumulateProjectAssetPixels(totalAssetPixels, inspectPng(bytes));
    assets.push({ asset, bytes });
  }
  return { document, assets };
}

/** Validate an exported JSON/asset directory before importing it into a new project. */
export async function readPortableProjectExport(exportDirectory: string): Promise<PortableProjectExport> {
  let manifest: Record<string, unknown>;
  let document: DesignDocument;
  let previewBytes: Buffer;
  try {
    const text = await readPortableFile(exportDirectory, 'manifest.json', 4 * 1024 * 1024).then((bytes) => bytes.toString('utf8'));
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Manifest must be an object');
    manifest = parsed as Record<string, unknown>;
    if (manifest.formatVersion !== 1 || typeof manifest.exportId !== 'string' || !exportIdPattern.test(manifest.exportId)) throw new Error('Manifest format or export ID is unsupported');

    const documentText = await readPortableFile(exportDirectory, 'design.json', MAX_RECORD_BYTES).then((bytes) => bytes.toString('utf8'));
    const validation = validateDesignDocument(JSON.parse(documentText) as unknown);
    if (!validation.success) throw new StoragePersistenceError('INVALID_DOCUMENT', `Portable design is invalid: ${validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
    document = validation.data;
    previewBytes = await readPortableFile(exportDirectory, 'preview.png', MAX_EXPORT_BYTES);
  } catch (error) {
    if (error instanceof StoragePersistenceError) throw error;
    throw new StoragePersistenceError('INVALID_EXPORT_PACKAGE', error instanceof Error ? error.message : 'Portable export package could not be read');
  }

  if (manifest.documentId !== document.documentId || manifest.documentRevision !== document.revision || manifest.mimeType !== 'image/png' || typeof manifest.pageId !== 'string') {
    throw new StoragePersistenceError('EXPORT_MANIFEST_MISMATCH', 'Portable manifest identity does not match its design document');
  }
  const page = document.pages.find((item) => item.id === manifest.pageId);
  if (!page) throw new StoragePersistenceError('EXPORT_PAGE_NOT_FOUND', 'Portable manifest refers to a missing page');
  if ((manifest.scale !== 1 && manifest.scale !== 2) || !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height)) {
    throw new StoragePersistenceError('EXPORT_DIMENSIONS_MISMATCH', 'Portable PNG size does not match the page bounds and scale');
  }
  const scale = manifest.scale;
  const width = manifest.width as number;
  const height = manifest.height as number;
  if (width !== Math.ceil(page.root.bounds.width * scale) || height !== Math.ceil(page.root.bounds.height * scale) || width > 4096 || height > 4096) throw new StoragePersistenceError('EXPORT_DIMENSIONS_MISMATCH', 'Portable PNG size does not match the page bounds and scale');
  const preview = inspectPng(previewBytes);
  if (preview.width !== width || preview.height !== height || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) || createHash('sha256').update(previewBytes).digest('hex') !== manifest.sha256) {
    throw new StoragePersistenceError('EXPORT_HASH_MISMATCH', 'Portable preview PNG does not match its manifest hash or dimensions');
  }

  const nodeIds: string[] = [];
  const stack: DesignNode[] = [page.root];
  while (stack.length) {
    const node = stack.pop()!;
    nodeIds.push(node.id);
    if (node.type === 'frame') stack.push(...node.children);
  }
  const manifestNodeIds = manifest.nodeIds;
  if (!Array.isArray(manifestNodeIds) || manifestNodeIds.some((id) => typeof id !== 'string') || manifestNodeIds.length !== nodeIds.length || new Set(manifestNodeIds).size !== nodeIds.length || nodeIds.some((id) => !manifestNodeIds.includes(id))) {
    throw new StoragePersistenceError('EXPORT_MANIFEST_MISMATCH', 'Portable manifest node list does not match the exported page');
  }

  if (!Array.isArray(manifest.assets) || manifest.assets.length !== Object.keys(document.assets).length) throw new StoragePersistenceError('EXPORT_ASSET_MISMATCH', 'Portable manifest asset list does not match its document');
  const manifestAssets = new Map<string, Record<string, unknown>>();
  for (const item of manifest.assets) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || manifestAssets.has(item.id)) throw new StoragePersistenceError('EXPORT_ASSET_MISMATCH', 'Portable manifest contains an invalid asset entry');
    manifestAssets.set(item.id, item as Record<string, unknown>);
  }
  const assets: ReadDesignAssetResult[] = [];
  let totalAssetBytes = 0;
  let totalAssetPixels = 0;
  for (const [assetId, rawAsset] of Object.entries(document.assets)) {
    const asset = validateAssetMeta(rawAsset, assetId);
    const entry = manifestAssets.get(assetId);
    if (!entry || asset.mimeType !== 'image/png' || entry.mimeType !== asset.mimeType || entry.relativePath !== asset.relativePath || entry.sha256 !== asset.sha256 || entry.byteSize !== asset.byteSize) {
      throw new StoragePersistenceError('EXPORT_ASSET_MISMATCH', `Portable manifest metadata does not match asset ${assetId}`);
    }
    totalAssetBytes += asset.byteSize;
    if (totalAssetBytes > MAX_EXPORT_ASSETS_BYTES) throw new StoragePersistenceError('EXPORT_ASSETS_TOO_LARGE', 'Portable export assets exceed the 100 MiB package limit');
    const bytes = await readPortableFile(exportDirectory, asset.relativePath, MAX_ASSET_BYTES);
    if (bytes.length !== asset.byteSize || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new StoragePersistenceError('ASSET_HASH_MISMATCH', `Portable asset failed hash validation: ${assetId}`);
    const dimensions = inspectPng(bytes);
    totalAssetPixels = accumulateProjectAssetPixels(totalAssetPixels, dimensions);
    if (entry.width !== dimensions.width || entry.height !== dimensions.height) throw new StoragePersistenceError('EXPORT_ASSET_MISMATCH', `Portable asset dimensions do not match manifest: ${assetId}`);
    assets.push({ asset, bytes });
  }
  return { document, assets, pageId: page.id, previewBytes };
}

function validateAssetMeta(input: unknown, expectedId?: string): DesignAsset {
  const parsed = assetMetaSchema.safeParse(input);
  if (!parsed.success) throw new StoragePersistenceError('INVALID_ASSET_META', `Asset metadata failed validation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  if (expectedId !== undefined && parsed.data.id !== expectedId) throw new StoragePersistenceError('ASSET_ID_MISMATCH', 'Asset metadata ID does not match the document record key');
  if (parsed.data.mimeType !== 'image/png') throw new StoragePersistenceError('UNSUPPORTED_ASSET_TYPE', 'This storage API currently accepts PNG assets only');
  return parsed.data;
}

function safeRelativeAssetSegments(relativePath: string): string[] {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || /^[a-zA-Z]:/.test(relativePath)) throw new StoragePersistenceError('INVALID_ASSET_PATH', 'Asset path must be normalized and project-relative');
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (!segment || Buffer.byteLength(segment, 'utf8') > 255 || segment === '.' || segment === '..' || /[\u0000-\u001f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new StoragePersistenceError('INVALID_ASSET_PATH', 'Asset path contains an unsafe filesystem segment');
    }
  }
  return segments;
}

async function resolveAssetFilePath(documentDirectory: string, relativePath: string, createDirectories: boolean): Promise<string> {
  const segments = safeRelativeAssetSegments(relativePath);
  let parent = documentDirectory;
  for (const segment of segments.slice(0, -1)) parent = await resolveChildDirectory(parent, segment, createDirectories);
  const filePath = path.join(parent, segments.at(-1)!);
  const relative = path.relative(documentDirectory, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new StoragePersistenceError('UNSAFE_PATH', 'Asset path escaped its document directory');
  return filePath;
}

async function readStoredPngAsset(documentDirectory: string, input: unknown, expectedId?: string): Promise<{ asset: DesignAsset; bytes: Buffer }> {
  const asset = validateAssetMeta(input, expectedId);
  const filePath = await resolveAssetFilePath(documentDirectory, asset.relativePath, false);
  let details;
  try { details = await lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StoragePersistenceError('ASSET_NOT_FOUND', `PNG asset is missing: ${asset.id}`);
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_PATH', 'PNG asset must be a regular file and cannot be a symbolic link');
  if (details.size > MAX_ASSET_BYTES) throw new StoragePersistenceError('ASSET_TOO_LARGE', `PNG asset exceeds ${MAX_ASSET_BYTES} bytes`);
  if (details.size !== asset.byteSize) throw new StoragePersistenceError('ASSET_SIZE_MISMATCH', `PNG asset size does not match metadata for ${asset.id}`);
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== asset.byteSize) throw new StoragePersistenceError('ASSET_SIZE_MISMATCH', `PNG asset changed while being read: ${asset.id}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== asset.sha256) throw new StoragePersistenceError('ASSET_HASH_MISMATCH', `PNG asset checksum does not match metadata for ${asset.id}`);
  inspectPng(bytes);
  return { asset, bytes };
}

/** Store a PNG by content hash under the document's project-relative assets directory. */
export async function saveDesignAsset(
  rootDirectory: string,
  projectId: string,
  documentId: string,
  assetId: string,
  mimeType: 'image/png',
  inputBytes: Uint8Array
): Promise<DesignAsset> {
  validateProjectId(projectId);
  validateDocumentId(documentId);
  if (!nodeIdSchema.safeParse(assetId).success) throw new StoragePersistenceError('INVALID_ASSET_ID', 'Invalid asset ID');
  if (mimeType !== 'image/png') throw new StoragePersistenceError('UNSUPPORTED_ASSET_TYPE', 'Only image/png assets can be saved by this API');
  if (!(inputBytes instanceof Uint8Array) || inputBytes.byteLength < 1 || inputBytes.byteLength > MAX_ASSET_BYTES) throw new StoragePersistenceError('ASSET_TOO_LARGE', `PNG assets must be between 1 and ${MAX_ASSET_BYTES} bytes`);
  const bytes = Buffer.from(inputBytes);
  inspectPng(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata = assetMetaSchema.parse({ id: assetId, mimeType, relativePath: `assets/${sha256}.png`, sha256, byteSize: bytes.byteLength });
  const { documentDirectory } = await resolveDocumentDirectory(rootDirectory, projectId, documentId, true);
  const assetsDirectory = await resolveChildDirectory(documentDirectory, 'assets', true);
  const filePath = await resolveAssetFilePath(documentDirectory, metadata.relativePath, false);

  return withJournalLock(filePath, async () => {
    try {
      const existing = await lstat(filePath);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_PATH', 'Asset target must be a regular file');
      const previous = await readStoredPngAsset(documentDirectory, metadata, assetId);
      if (!previous.bytes.equals(bytes)) throw new StoragePersistenceError('ASSET_HASH_COLLISION', 'Stored asset content differs despite matching SHA-256');
      return metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicReplaceFile(filePath, bytes);
    await syncDirectory(assetsDirectory);
    return metadata;
  });
}

/** Read a PNG asset referenced by the recovered, validated document revision. */
export async function readDesignAsset(rootDirectory: string, projectId: string, documentId: string, assetId: string): Promise<ReadDesignAssetResult> {
  validateDocumentId(documentId);
  if (!nodeIdSchema.safeParse(assetId).success) throw new StoragePersistenceError('INVALID_ASSET_ID', 'Invalid asset ID');
  const recovered = await loadRecoverableDesignDocument(rootDirectory, projectId, documentId);
  const asset = recovered.document.assets[assetId];
  if (!asset) throw new StoragePersistenceError('ASSET_NOT_FOUND', `Document ${documentId} does not declare asset ${assetId}`);
  return readDesignAssetMetadata(rootDirectory, projectId, documentId, asset);
}

/** Read and hash-verify a PNG using metadata from a validated pending document transaction. */
export async function readDesignAssetMetadata(rootDirectory: string, projectId: string, documentId: string, input: unknown): Promise<ReadDesignAssetResult> {
  validateDocumentId(documentId);
  const asset = validateAssetMeta(input);
  const { documentDirectory } = await resolveDocumentDirectory(rootDirectory, projectId, documentId, false);
  const verified = await readStoredPngAsset(documentDirectory, asset, asset.id);
  return { asset: verified.asset, bytes: verified.bytes };
}

async function writeStagedAsset(stagingDirectory: string, relativePath: string, bytes: Buffer): Promise<void> {
  const segments = safeRelativeAssetSegments(relativePath);
  let parent = stagingDirectory;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(parent, segment);
    await mkdir(next, { recursive: true });
    const details = await lstat(next);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_PATH', 'Export asset directories cannot be symbolic links');
    const actual = await realpath(next);
    if (path.dirname(actual) !== parent) throw new StoragePersistenceError('UNSAFE_PATH', 'Export asset directory escaped its staging directory');
    await syncDirectory(parent);
    parent = actual;
  }
  const filePath = path.join(parent, segments.at(-1)!);
  const handle = await open(filePath, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(parent);
}

/** Atomically persist a validated PNG export, the exact source revision, and a manifest. */
export async function writeProjectExport(
  rootDirectory: string,
  projectId: string,
  exportId: string,
  input: DesignDocument,
  pngBytes: Uint8Array,
  metadata: PngExportMetadata
): Promise<SavedProjectExport> {
  validateProjectId(projectId);
  if (!exportIdPattern.test(exportId)) throw new StoragePersistenceError('INVALID_EXPORT_ID', 'Invalid export ID');
  const document = validateDocument(input);
  if (metadata.documentId !== document.documentId || metadata.documentRevision !== document.revision || metadata.mimeType !== 'image/png') throw new StoragePersistenceError('EXPORT_REVISION_MISMATCH', 'Export metadata must identify the supplied document revision and PNG type');
  const page = document.pages.find((item) => item.id === metadata.pageId);
  if (!page) throw new StoragePersistenceError('EXPORT_PAGE_NOT_FOUND', 'Export metadata refers to a missing page');
  if ((metadata.scale !== 1 && metadata.scale !== 2) || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || metadata.width > 4096 || metadata.height > 4096) throw new StoragePersistenceError('INVALID_EXPORT_METADATA', 'Export scale and dimensions are invalid');
  if (metadata.width !== Math.ceil(page.root.bounds.width * metadata.scale) || metadata.height !== Math.ceil(page.root.bounds.height * metadata.scale)) throw new StoragePersistenceError('EXPORT_DIMENSIONS_MISMATCH', 'Export dimensions must match the page bounds multiplied by the selected scale');
  if (!Array.isArray(metadata.nodeIds) || metadata.nodeIds.length > 10_000 || metadata.nodeIds.some((id) => !nodeIdSchema.safeParse(id).success)) throw new StoragePersistenceError('INVALID_EXPORT_METADATA', 'Export node IDs are invalid');
  const knownNodeIds = new Set<string>();
  const stack: DesignNode[] = [page.root];
  while (stack.length) {
    const node = stack.pop()!;
    knownNodeIds.add(node.id);
    if (node.type === 'frame') stack.push(...node.children);
  }
  if (metadata.nodeIds.some((id) => !knownNodeIds.has(id))) throw new StoragePersistenceError('INVALID_EXPORT_METADATA', 'Export metadata refers to a node outside the selected page');
  if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength > MAX_EXPORT_BYTES) throw new StoragePersistenceError('EXPORT_TOO_LARGE', `PNG export exceeds ${MAX_EXPORT_BYTES} bytes`);
  const png = Buffer.from(pngBytes);
  const dimensions = inspectPng(png);
  if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) throw new StoragePersistenceError('EXPORT_DIMENSIONS_MISMATCH', 'PNG dimensions do not match export metadata');

  const projectDirectory = await resolveProjectDirectory(rootDirectory, projectId, true);
  const exportAssets: Array<{ metadata: DesignAsset; bytes: Buffer; width: number; height: number }> = [];
  let exportAssetsByteSize = 0;
  let exportAssetsPixelSize = 0;
  if (Object.keys(document.assets).length > 0) {
    let documentDirectory: string;
    try { documentDirectory = await resolveChildDirectory(projectDirectory, document.documentId, false); }
    catch { throw new StoragePersistenceError('ASSET_NOT_FOUND', 'The document asset directory does not exist'); }
    const exportedPaths = new Map<string, { relativePath: string; sha256: string }>();
    for (const [assetId, rawAsset] of Object.entries(document.assets).sort(([a], [b]) => a.localeCompare(b))) {
      const asset = validateAssetMeta(rawAsset, assetId);
      if (['design.json', 'preview.png', 'manifest.json'].includes(asset.relativePath.split('/')[0]!.toLowerCase())) throw new StoragePersistenceError('EXPORT_ASSET_PATH_CONFLICT', `Asset path conflicts with an export file: ${asset.relativePath}`);
      const pathKey = asset.relativePath.toLowerCase();
      const existingPath = exportedPaths.get(pathKey);
      if (existingPath && (existingPath.sha256 !== asset.sha256 || existingPath.relativePath !== asset.relativePath)) throw new StoragePersistenceError('EXPORT_ASSET_PATH_CONFLICT', `Multiple assets collide on an export path: ${asset.relativePath}`);
      exportedPaths.set(pathKey, { relativePath: asset.relativePath, sha256: asset.sha256 });
      const verified = await readStoredPngAsset(documentDirectory, asset, assetId);
      const assetDimensions = inspectPng(verified.bytes);
      exportAssetsByteSize += verified.bytes.byteLength;
      if (exportAssetsByteSize > MAX_EXPORT_ASSETS_BYTES) throw new StoragePersistenceError('EXPORT_ASSETS_TOO_LARGE', `Project assets exceed ${MAX_EXPORT_ASSETS_BYTES} bytes`);
      exportAssetsPixelSize = accumulateProjectAssetPixels(exportAssetsPixelSize, assetDimensions);
      exportAssets.push({ metadata: verified.asset, bytes: verified.bytes, ...assetDimensions });
    }
  }
  const exportsDirectory = await resolveChildDirectory(projectDirectory, 'exports', true);
  const exportPath = path.join(exportsDirectory, exportId);
  try {
    await lstat(exportPath);
    throw new StoragePersistenceError('EXPORT_ALREADY_EXISTS', `Export already exists: ${exportId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stagingPath = path.join(exportsDirectory, `.staging-${randomUUID()}`);
  await mkdir(stagingPath);
  const documentPath = path.join(stagingPath, 'design.json');
  const imagePath = path.join(stagingPath, 'preview.png');
  const manifestPath = path.join(stagingPath, 'manifest.json');
  const sha256 = createHash('sha256').update(png).digest('hex');
  const manifest = {
    formatVersion: 1,
    exportId,
    documentId: document.documentId,
    documentRevision: document.revision,
    pageId: metadata.pageId,
    nodeIds: [...metadata.nodeIds],
    width: metadata.width,
    height: metadata.height,
    scale: metadata.scale,
    mimeType: 'image/png' as const,
    sha256,
    assets: exportAssets.map(({ metadata: asset, width, height }) => ({
      id: asset.id, mimeType: asset.mimeType, relativePath: asset.relativePath, sha256: asset.sha256, byteSize: asset.byteSize, width, height
    })),
    createdAt: new Date().toISOString()
  };
  try {
    for (const [filePath, content] of [[documentPath, `${JSON.stringify(document, null, 2)}\n`], [imagePath, png], [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`]] as const) {
      const handle = await open(filePath, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    }
    const copiedPaths = new Set<string>();
    for (const asset of exportAssets) {
      const pathKey = asset.metadata.relativePath.toLowerCase();
      if (copiedPaths.has(pathKey)) continue;
      await writeStagedAsset(stagingPath, asset.metadata.relativePath, asset.bytes);
      copiedPaths.add(pathKey);
    }
    await syncDirectory(stagingPath);
    await rename(stagingPath, exportPath);
    await syncDirectory(exportsDirectory);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    exportPath,
    documentPath: path.join(exportPath, 'design.json'),
    imagePath: path.join(exportPath, 'preview.png'),
    manifestPath: path.join(exportPath, 'manifest.json'),
    sha256
  };
}

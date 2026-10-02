import { randomUUID } from 'node:crypto';
import {
  validateDesignDocument,
  type DesignDocument,
  type DesignNode,
  type DesignNodeBase
} from '@miaoma/design-schema';

type RectangleNode = Extract<DesignNode, { type: 'rectangle' }>;
type TextNode = Extract<DesignNode, { type: 'text' }>;
type IconNode = Extract<DesignNode, { type: 'icon' }>;
type FrameNode = Extract<DesignNode, { type: 'frame' }>;

export type NodeUpdate = Partial<Pick<DesignNodeBase, 'name' | 'visible' | 'locked' | 'bounds' | 'transform' | 'style'>>
  & Partial<Pick<RectangleNode, 'radius'>>
  & Partial<Pick<TextNode, 'text' | 'typography' | 'sizing'>>
  & Partial<Pick<IconNode, 'iconKey'>>
  & Partial<Pick<FrameNode, 'layout' | 'clipContent'>>;

export type EditorCommand =
  | { type: 'rename-document'; title: string }
  | { type: 'add-asset'; asset: DesignDocument['assets'][string] }
  | { type: 'create'; parentId: string; node: DesignNode; index?: number }
  | { type: 'update'; nodeId: string; patch: NodeUpdate }
  | { type: 'delete'; nodeId: string }
  | { type: 'reparent'; nodeId: string; parentId: string; index?: number }
  | { type: 'reorder'; nodeId: string; index: number };

export interface ExecuteCommandsRequest {
  baseRevision: number;
  commands: readonly EditorCommand[];
  commandId?: string;
}

export interface HistoryState {
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
}

export interface CommandResult {
  document: DesignDocument;
  revision: number;
  transactionId: string | null;
  changed: boolean;
  history: HistoryState;
}

export interface PreparedTransaction {
  readonly kind: 'commands' | 'undo' | 'redo';
  readonly baseRevision: number;
  readonly revision: number;
  readonly transactionId: string | null;
  readonly changed: boolean;
  readonly commands: readonly EditorCommand[] | null;
  /** Frozen, detached snapshot suitable for persistence before state publication. */
  readonly document: DesignDocument;
}

export type EditorErrorCode =
  | 'REVISION_CONFLICT'
  | 'INVALID_COMMAND'
  | 'INVALID_DOCUMENT'
  | 'NODE_NOT_FOUND'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_NOT_FRAME'
  | 'ROOT_NODE_IMMUTABLE'
  | 'NODE_LOCKED'
  | 'INVALID_INDEX'
  | 'CYCLE_DETECTED'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO';

export class EditorCommandError extends Error {
  constructor(readonly code: EditorErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'EditorCommandError';
  }
}

type HistoryEntry = {
  transactionId: string;
  before: DesignDocument;
  after: DesignDocument;
};

type InternalPrepared = {
  kind: PreparedTransaction['kind'];
  baseRevision: number;
  candidate: DesignDocument;
  transactionId: string | null;
  changed: boolean;
  commands: readonly EditorCommand[] | null;
  historyEntry?: HistoryEntry;
};

const MAX_HISTORY = 1_000;
const MAX_TRANSACTION_COMMANDS = 1_000;

function cloneDocument(document: DesignDocument): DesignDocument {
  return structuredClone(document);
}

function sameDocumentContent(left: DesignDocument, right: DesignDocument): boolean {
  const a = cloneDocument(left);
  const b = cloneDocument(right);
  a.revision = 0;
  b.revision = 0;
  return JSON.stringify(a) === JSON.stringify(b);
}

function invalidDocument(document: unknown): never {
  const result = validateDesignDocument(document);
  if (result.success) throw new Error('Expected invalid document');
  throw new EditorCommandError('INVALID_DOCUMENT', result.diagnostics.map((item) => `${item.code} ${item.path.join('.')}: ${item.message}`).join('; '), { diagnostics: result.diagnostics });
}

function findNode(document: DesignDocument, nodeId: string): { node: DesignNode; page: DesignDocument['pages'][number]; parent: FrameNode | null; index: number; ancestors: FrameNode[] } | null {
  for (const page of document.pages) {
    const walk = (node: DesignNode, parent: FrameNode | null, index: number, ancestors: FrameNode[]): ReturnType<typeof findNode> => {
      if (node.id === nodeId) return { node, page, parent, index, ancestors };
      if (node.type === 'frame') {
        const nextAncestors = [...ancestors, node];
        for (let childIndex = 0; childIndex < node.children.length; childIndex++) {
          const match = walk(node.children[childIndex]!, node, childIndex, nextAncestors);
          if (match) return match;
        }
      }
      return null;
    };
    const match = walk(page.root, null, -1, []);
    if (match) return match;
  }
  return null;
}

function assertUnlocked(targetId: string, found: NonNullable<ReturnType<typeof findNode>>, allowUnlockTarget = false): void {
  if (found.ancestors.some((ancestor) => ancestor.locked)) {
    throw new EditorCommandError('NODE_LOCKED', `Node ${targetId} is inside a locked frame`, { nodeId: targetId });
  }
  if (found.node.locked && !allowUnlockTarget) {
    throw new EditorCommandError('NODE_LOCKED', `Node ${targetId} is locked`, { nodeId: targetId });
  }
}

function checkIndex(index: number | undefined, length: number, allowEnd: boolean): number {
  const resolved = index ?? length;
  const max = allowEnd ? length : length - 1;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new EditorCommandError('INVALID_INDEX', `Index must be an integer between 0 and ${Math.max(max, 0)}`, { index: resolved, length });
  }
  return resolved;
}

function assertSafeCreatedNode(input: unknown): asserts input is DesignNode {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: input, depth: 1 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new EditorCommandError('INVALID_COMMAND', 'Created node tree must contain only object nodes');
    }
    if (seen.has(node)) throw new EditorCommandError('INVALID_COMMAND', 'Created node tree must be acyclic and cannot share node objects');
    seen.add(node);
    if (++count > 10_000 || depth > 64) throw new EditorCommandError('INVALID_COMMAND', 'Created node tree exceeds the DSL v1 size or depth limit');
    const record = node as { type?: unknown; children?: unknown };
    if (record.type === 'frame') {
      if (!Array.isArray(record.children)) throw new EditorCommandError('INVALID_COMMAND', 'Created frame must have a children array');
      for (const child of record.children) stack.push({ node: child, depth: depth + 1 });
    }
  }
}

function assertNodeAndParentIdsAreDistinct(document: DesignDocument, nodeId: string, parentId: string): void {
  if (nodeId === parentId) throw new EditorCommandError('CYCLE_DETECTED', 'A node cannot be its own parent', { nodeId, parentId });
  const parent = findNode(document, parentId);
  if (!parent) throw new EditorCommandError('PARENT_NOT_FOUND', `Parent ${parentId} was not found`, { parentId });
  if (parent.node.type !== 'frame') throw new EditorCommandError('PARENT_NOT_FRAME', `Parent ${parentId} must be a frame`, { parentId });
}

function isDescendant(document: DesignDocument, ancestorId: string, candidateId: string): boolean {
  const ancestor = findNode(document, ancestorId);
  if (!ancestor || ancestor.node.type !== 'frame') return false;
  const stack = [...ancestor.node.children];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === candidateId) return true;
    if (node.type === 'frame') stack.push(...node.children);
  }
  return false;
}

function ensurePatch(patch: NodeUpdate): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new EditorCommandError('INVALID_COMMAND', 'Update patch must be a plain object');
  }
  const keys = Object.keys(patch);
  const allowed = new Set(['name', 'visible', 'locked', 'bounds', 'transform', 'style', 'radius', 'text', 'typography', 'sizing', 'iconKey', 'layout', 'clipContent']);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new EditorCommandError('INVALID_COMMAND', 'Update patch must contain supported fields and cannot modify id, type, or children', { keys });
  }
  return keys;
}

function applyCommand(document: DesignDocument, command: EditorCommand): void {
  if (!command || typeof command !== 'object' || !('type' in command)) {
    throw new EditorCommandError('INVALID_COMMAND', 'Command must be an object with a type');
  }

  switch (command.type) {
    case 'rename-document': {
      const title = typeof command.title === 'string' ? command.title.trim() : '';
      if (!title || title.length > 256) throw new EditorCommandError('INVALID_COMMAND', 'Document title must contain between 1 and 256 characters');
      document.title = title;
      return;
    }
    case 'add-asset': {
      const asset = structuredClone(command.asset);
      if (!asset || typeof asset !== 'object' || !asset.id || document.assets[asset.id]) {
        throw new EditorCommandError('INVALID_COMMAND', 'Asset ID is invalid or already exists');
      }
      document.assets[asset.id] = asset;
      return;
    }
    case 'create': {
      const parent = findNode(document, command.parentId);
      if (!parent) throw new EditorCommandError('PARENT_NOT_FOUND', `Parent ${command.parentId} was not found`, { parentId: command.parentId });
      if (parent.node.type !== 'frame') throw new EditorCommandError('PARENT_NOT_FRAME', `Parent ${command.parentId} must be a frame`, { parentId: command.parentId });
      assertUnlocked(command.parentId, parent);
      const insertAt = checkIndex(command.index, parent.node.children.length, true);
      let node: unknown;
      try {
        node = structuredClone(command.node);
      } catch {
        throw new EditorCommandError('INVALID_COMMAND', 'Created node must be structured-cloneable DSL data');
      }
      assertSafeCreatedNode(node);
      parent.node.children.splice(insertAt, 0, node);
      return;
    }
    case 'update': {
      const found = findNode(document, command.nodeId);
      if (!found) throw new EditorCommandError('NODE_NOT_FOUND', `Node ${command.nodeId} was not found`, { nodeId: command.nodeId });
      const keys = ensurePatch(command.patch);
      const lockOnlyUpdate = keys.length === 1 && keys[0] === 'locked' && typeof command.patch.locked === 'boolean';
      assertUnlocked(command.nodeId, found, lockOnlyUpdate);
      for (const key of keys) (found.node as unknown as Record<string, unknown>)[key] = structuredClone((command.patch as Record<string, unknown>)[key]);
      return;
    }
    case 'delete': {
      const found = findNode(document, command.nodeId);
      if (!found) throw new EditorCommandError('NODE_NOT_FOUND', `Node ${command.nodeId} was not found`, { nodeId: command.nodeId });
      if (!found.parent) throw new EditorCommandError('ROOT_NODE_IMMUTABLE', 'A page root frame cannot be deleted', { nodeId: command.nodeId });
      assertUnlocked(command.nodeId, found);
      found.parent.children.splice(found.index, 1);
      return;
    }
    case 'reparent': {
      const found = findNode(document, command.nodeId);
      if (!found) throw new EditorCommandError('NODE_NOT_FOUND', `Node ${command.nodeId} was not found`, { nodeId: command.nodeId });
      if (!found.parent) throw new EditorCommandError('ROOT_NODE_IMMUTABLE', 'A page root frame cannot be reparented', { nodeId: command.nodeId });
      assertUnlocked(command.nodeId, found);
      assertNodeAndParentIdsAreDistinct(document, command.nodeId, command.parentId);
      if (isDescendant(document, command.nodeId, command.parentId)) {
        throw new EditorCommandError('CYCLE_DETECTED', 'A node cannot be reparented into its own subtree', { nodeId: command.nodeId, parentId: command.parentId });
      }
      const target = findNode(document, command.parentId)!;
      assertUnlocked(command.parentId, target);
      const targetFrame = target.node as FrameNode;
      const sameParent = targetFrame === found.parent;
      const resultingLength = targetFrame.children.length - (sameParent ? 1 : 0);
      const insertAt = checkIndex(command.index, resultingLength, true);
      const [node] = found.parent.children.splice(found.index, 1);
      targetFrame.children.splice(insertAt, 0, node!);
      return;
    }
    case 'reorder': {
      const found = findNode(document, command.nodeId);
      if (!found) throw new EditorCommandError('NODE_NOT_FOUND', `Node ${command.nodeId} was not found`, { nodeId: command.nodeId });
      if (!found.parent) throw new EditorCommandError('ROOT_NODE_IMMUTABLE', 'A page root frame cannot be reordered', { nodeId: command.nodeId });
      assertUnlocked(command.nodeId, found);
      const to = checkIndex(command.index, found.parent.children.length, false);
      if (to !== found.index) {
        const [node] = found.parent.children.splice(found.index, 1);
        found.parent.children.splice(to, 0, node!);
      }
      return;
    }
    default:
      throw new EditorCommandError('INVALID_COMMAND', `Unsupported command type: ${String((command as { type: unknown }).type)}`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Authoritative, single-writer document state. Callers only receive snapshots;
 * mutations are validated and published by CommandService as atomic revisions.
 */
export class DocumentStore {
  #document: DesignDocument;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #prepared = new WeakMap<object, InternalPrepared>();

  constructor(document: DesignDocument) {
    const validation = validateDesignDocument(document);
    if (!validation.success) invalidDocument(document);
    this.#document = cloneDocument(validation.data);
  }

  getSnapshot(): DesignDocument {
    return cloneDocument(this.#document);
  }

  getHistoryState(): HistoryState {
    return { revision: this.#document.revision, canUndo: this.#undo.length > 0, canRedo: this.#redo.length > 0, undoDepth: this.#undo.length, redoDepth: this.#redo.length };
  }

  /** @internal Prepare a validated edit without publishing it to live state. */
  prepareTransaction(baseRevision: number, commands: readonly EditorCommand[], commandId?: string): PreparedTransaction {
    this.#assertRevision(baseRevision);
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_TRANSACTION_COMMANDS) {
      throw new EditorCommandError('INVALID_COMMAND', `A transaction must contain between 1 and ${MAX_TRANSACTION_COMMANDS} commands`);
    }
    if (commandId !== undefined && (typeof commandId !== 'string' || commandId.length < 1 || commandId.length > 128)) {
      throw new EditorCommandError('INVALID_COMMAND', 'commandId must contain between 1 and 128 characters');
    }
    const before = this.getSnapshot();
    const candidate = cloneDocument(before);
    for (const command of commands) applyCommand(candidate, command);
    const nextRevision = before.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) throw new EditorCommandError('INVALID_DOCUMENT', 'Document revision has reached the safe integer limit');
    candidate.revision = nextRevision;
    const validation = validateDesignDocument(candidate);
    if (!validation.success) invalidDocument(candidate);
    if (sameDocumentContent(before, validation.data)) {
      return this.#registerPrepared({ kind: 'commands', baseRevision, candidate: before, transactionId: null, changed: false, commands });
    }
    const transactionId = commandId ?? `txn_${randomUUID().replaceAll('-', '')}`;
    return this.#registerPrepared({ kind: 'commands', baseRevision, candidate: cloneDocument(validation.data), transactionId, changed: true, commands });
  }

  /** @internal Prepare one undo/redo snapshot without changing history. */
  prepareHistory(baseRevision: number, direction: 'undo' | 'redo'): PreparedTransaction {
    this.#assertRevision(baseRevision);
    const source = direction === 'undo' ? this.#undo : this.#redo;
    const entry = source[source.length - 1];
    if (!entry) {
      throw new EditorCommandError(direction === 'undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO', `There is no transaction to ${direction}`);
    }
    const target = cloneDocument(direction === 'undo' ? entry.before : entry.after);
    target.revision = this.#document.revision + 1;
    if (!Number.isSafeInteger(target.revision)) throw new EditorCommandError('INVALID_DOCUMENT', 'Document revision has reached the safe integer limit');
    const validation = validateDesignDocument(target);
    if (!validation.success) invalidDocument(target);
    return this.#registerPrepared({ kind: direction, baseRevision, candidate: cloneDocument(validation.data), transactionId: entry.transactionId, changed: true, commands: null, historyEntry: entry });
  }

  /**
   * Publish a prepared candidate after its durable write succeeds. Prepared values
   * are one-use and bound to this store; a stale or forged value cannot overwrite it.
   */
  commitPrepared(prepared: PreparedTransaction): CommandResult {
    const internal = prepared && typeof prepared === 'object' ? this.#prepared.get(prepared as object) : undefined;
    if (!internal) throw new EditorCommandError('INVALID_COMMAND', 'Prepared transaction is unknown, already committed, or belongs to another store');
    this.#assertRevision(internal.baseRevision);
    this.#prepared.delete(prepared as object);
    if (internal.changed) {
      const before = this.getSnapshot();
      if (internal.kind === 'commands') {
        this.#undo.push({ transactionId: internal.transactionId!, before, after: cloneDocument(internal.candidate) });
        if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
        this.#redo = [];
      } else {
        const source = internal.kind === 'undo' ? this.#undo : this.#redo;
        const destination = internal.kind === 'undo' ? this.#redo : this.#undo;
        if (source[source.length - 1] !== internal.historyEntry) {
          throw new EditorCommandError('REVISION_CONFLICT', 'History changed after this operation was prepared', { baseRevision: internal.baseRevision, actualRevision: this.#document.revision });
        }
        source.pop();
        destination.push(internal.historyEntry!);
        if (destination === this.#undo && this.#undo.length > MAX_HISTORY) this.#undo.shift();
      }
      this.#document = cloneDocument(internal.candidate);
    }
    return { document: this.getSnapshot(), revision: this.#document.revision, transactionId: internal.transactionId, changed: internal.changed, history: this.getHistoryState() };
  }

  #registerPrepared(internal: InternalPrepared): PreparedTransaction {
    const document = deepFreeze(cloneDocument(internal.candidate));
    const commands = internal.commands ? deepFreeze(structuredClone(internal.commands)) : null;
    const prepared: PreparedTransaction = Object.freeze({
      kind: internal.kind,
      baseRevision: internal.baseRevision,
      revision: internal.candidate.revision,
      transactionId: internal.transactionId,
      changed: internal.changed,
      commands,
      document
    });
    this.#prepared.set(prepared, { ...internal, commands });
    return prepared;
  }

  #assertRevision(baseRevision: number): void {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new EditorCommandError('INVALID_COMMAND', 'baseRevision must be a non-negative safe integer', { baseRevision });
    }
    if (baseRevision !== this.#document.revision) {
      throw new EditorCommandError('REVISION_CONFLICT', `Expected revision ${baseRevision}, current revision is ${this.#document.revision}`, { expectedRevision: baseRevision, actualRevision: this.#document.revision });
    }
  }
}

/** Synchronous command boundary: each call is one serializable document write. */
export class CommandService {
  constructor(readonly store: DocumentStore) {}

  prepare(request: ExecuteCommandsRequest): PreparedTransaction {
    return this.store.prepareTransaction(request.baseRevision, request.commands, request.commandId);
  }

  prepareUndo(baseRevision: number): PreparedTransaction {
    return this.store.prepareHistory(baseRevision, 'undo');
  }

  prepareRedo(baseRevision: number): PreparedTransaction {
    return this.store.prepareHistory(baseRevision, 'redo');
  }

  commitPrepared(prepared: PreparedTransaction): CommandResult {
    return this.store.commitPrepared(prepared);
  }

  execute(request: ExecuteCommandsRequest): CommandResult {
    return this.commitPrepared(this.prepare(request));
  }

  undo(baseRevision: number): CommandResult {
    return this.commitPrepared(this.prepareUndo(baseRevision));
  }

  redo(baseRevision: number): CommandResult {
    return this.commitPrepared(this.prepareRedo(baseRevision));
  }
}

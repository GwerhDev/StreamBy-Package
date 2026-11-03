import crypto from 'crypto';
import { nosqlDb } from '../utils/nosqlDb';
import { PRODUCTION_STATUSES } from './productionFields';

// A project's Production board: its columns, in order, each in one of the fixed statuses. A
// card (a shot) is in a column, and its status is that column's.
//
// A project that never changed its board has one column per status, its id the status itself:
// a card saved before columns existed (no columnId) is in the first column of its status, so
// existing projects keep their cards where they were. Before the board changes for the first
// time, those cards are given that column for good (see settleCards), so a change to the columns
// never moves them on its own.

export type ProductionStatus = typeof PRODUCTION_STATUSES[number];

export interface BoardColumn {
  id: string;
  name: string;
  status: ProductionStatus;
}

const DEFAULT_NAMES: Record<ProductionStatus, string> = { todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };
export const DEFAULT_COLUMNS: BoardColumn[] = PRODUCTION_STATUSES.map(status => ({ id: status, name: DEFAULT_NAMES[status], status }));

const MAX_NAME = 60;

// The board's document also keeps the project's card key and the last card number given (see
// cardKeys.ts).
const boards = () => nosqlDb()?.collection<{ projectId: string; columns: BoardColumn[]; key?: string; lastNumber?: number; updatedAt: Date }>('production_boards') ?? null;

/** A project's columns, in order. */
export async function readColumns(projectId: string): Promise<BoardColumn[]> {
  const board = await boards()?.findOne({ projectId });
  return board?.columns?.length ? board.columns : DEFAULT_COLUMNS;
}

/** The first column of a status. */
export const firstColumnOf = (columns: BoardColumn[], status: string): BoardColumn | undefined =>
  columns.find(c => c.status === status);

/** The column a card is in: its own, or (saved before it had one) the first of its status. */
export function columnOfCard(columns: BoardColumn[], card: { columnId?: string | null; status?: string }): BoardColumn | undefined {
  return columns.find(c => c.id === card.columnId) ?? firstColumnOf(columns, card.status ?? 'todo') ?? columns[0];
}

/** A card as it's answered: in its column, with that column's status. */
export function withColumn<T extends Record<string, any>>(columns: BoardColumn[], card: T): T & { columnId: string; status: string } {
  const column = columnOfCard(columns, card);
  return { ...card, columnId: column?.id ?? card.columnId ?? '', status: column?.status ?? card.status ?? 'todo' };
}

// Cards without a column given theirs (the first of their status, as they're shown) before the
// columns change, so the change doesn't move them.
async function settleCards(projectId: string, columns: BoardColumn[]): Promise<void> {
  const shots = nosqlDb()?.collection('production_shots');
  if (!shots) return;
  for (const status of PRODUCTION_STATUSES) {
    const column = firstColumnOf(columns, status);
    if (column) await shots.updateMany({ projectId, columnId: { $exists: false }, status }, { $set: { columnId: column.id } });
  }
}

async function saveColumns(projectId: string, before: BoardColumn[], columns: BoardColumn[]): Promise<void> {
  await settleCards(projectId, before);
  await boards()!.updateOne({ projectId }, { $set: { projectId, columns, updatedAt: new Date() } }, { upsert: true });
}

export type BoardResult = { columns: BoardColumn[] } | { error: string; status?: number };

const statusesKept = (columns: BoardColumn[]) => PRODUCTION_STATUSES.every(st => columns.some(c => c.status === st));
const KEEP_STATUSES = 'Each status keeps at least one column';

const checkName = (name: unknown): string | { error: string } => {
  if (typeof name !== 'string' || !name.trim()) return { error: 'name must not be blank' };
  if (name.trim().length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };
  return name.trim();
};
const isStatus = (status: unknown): status is ProductionStatus => (PRODUCTION_STATUSES as readonly unknown[]).includes(status);

/** A new column (`position` in the order, last when not given). */
export async function addColumn(projectId: string, body: any): Promise<BoardResult> {
  if (!boards()) return { error: 'Database not available', status: 500 };
  const name = checkName(body?.name);
  if (typeof name !== 'string') return name;
  if (!isStatus(body?.status)) return { error: `status must be one of ${PRODUCTION_STATUSES.join(', ')}` };
  const before = await readColumns(projectId);
  const position = typeof body?.position === 'number' ? Math.max(0, Math.min(before.length, Math.floor(body.position))) : before.length;
  const columns = [...before];
  columns.splice(position, 0, { id: crypto.randomUUID(), name, status: body.status });
  await saveColumns(projectId, before, columns);
  return { columns };
}

/** A column renamed, or given another status (its cards with it). */
export async function changeColumn(projectId: string, columnId: string, body: any): Promise<BoardResult> {
  if (!boards()) return { error: 'Database not available', status: 500 };
  const before = await readColumns(projectId);
  const column = before.find(c => c.id === columnId);
  if (!column) return { error: 'Column not found', status: 404 };
  const changed = { ...column };
  if (body?.name !== undefined) {
    const name = checkName(body.name);
    if (typeof name !== 'string') return name;
    changed.name = name;
  }
  if (body?.status !== undefined) {
    if (!isStatus(body.status)) return { error: `status must be one of ${PRODUCTION_STATUSES.join(', ')}` };
    changed.status = body.status;
  }
  const columns = before.map(c => (c.id === columnId ? changed : c));
  if (!statusesKept(columns)) return { error: KEEP_STATUSES };
  await saveColumns(projectId, before, columns);
  if (changed.status !== column.status) {
    await nosqlDb()!.collection('production_shots').updateMany({ projectId, columnId }, { $set: { status: changed.status, updatedAt: new Date() } });
  }
  return { columns };
}

/** The columns in another order: all of them, each once. */
export async function orderColumns(projectId: string, ids: unknown): Promise<BoardResult> {
  if (!boards()) return { error: 'Database not available', status: 500 };
  const before = await readColumns(projectId);
  if (!Array.isArray(ids) || ids.length !== before.length || new Set(ids).size !== ids.length || !ids.every(id => before.some(c => c.id === id))) {
    return { error: 'order must list every column of the board, each once' };
  }
  const columns = (ids as string[]).map(id => before.find(c => c.id === id)!);
  await saveColumns(projectId, before, columns);
  return { columns };
}

/** A column deleted; its cards, if it has any, moved to `moveTo` (and its status). */
export async function deleteColumn(projectId: string, columnId: string, moveTo: unknown): Promise<BoardResult & { moved?: number }> {
  if (!boards()) return { error: 'Database not available', status: 500 };
  const before = await readColumns(projectId);
  if (!before.some(c => c.id === columnId)) return { error: 'Column not found', status: 404 };
  const columns = before.filter(c => c.id !== columnId);
  if (!statusesKept(columns)) return { error: KEEP_STATUSES };

  await settleCards(projectId, before);
  const shots = nosqlDb()!.collection('production_shots');
  const cards = await shots.countDocuments({ projectId, columnId });
  const target = columns.find(c => c.id === moveTo);
  if (cards && !target) return { error: 'The column has cards: moveTo must be another column of the board to move them to' };
  if (cards) await shots.updateMany({ projectId, columnId }, { $set: { columnId: target!.id, status: target!.status, updatedAt: new Date() } });
  await saveColumns(projectId, before, columns);
  return { columns, moved: cards };
}

/** A deleted project's board. */
export async function deleteBoardOf(projectId: string): Promise<void> {
  if (projectId) await boards()?.deleteMany({ projectId });
}

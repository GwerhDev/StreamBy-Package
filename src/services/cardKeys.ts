import { nosqlDb } from '../utils/nosqlDb';

// A card's key: its project's short key and its number in the project, e.g. WOG-12. The project
// key is derived from the project's name until an admin gives it one. Numbers go up by one and
// are never given again, a deleted card's neither: the last one given is kept on the board's
// document. Cards made before keys existed are numbered by when they were made, the first time
// the project's cards are read or one is made.

const boards = () => nosqlDb()?.collection('production_boards') ?? null;
const shots = () => nosqlDb()?.collection('production_shots') ?? null;

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** A project's key from its name: the initials of its words (World of Gwerh: WOG), or the first letters of a single word. */
export function defaultKeyOf(name: string | undefined): string {
  const words = (name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const key = (words.length > 1 ? words.map(w => w[0]).join('') : words[0]?.slice(0, 3) ?? '').replace(/^[0-9]+/, '').slice(0, 10);
  return key.length >= 2 ? key : 'CARD';
}

/** A project's key: the one an admin gave it, or its name's. */
export async function readKey(projectId: string, projectName: string | undefined): Promise<string> {
  const board = await boards()?.findOne({ projectId });
  return board?.key || defaultKeyOf(projectName);
}

/** A project given another key: 2 to 10 letters and digits, starting with a letter. */
export async function setKey(projectId: string, key: unknown): Promise<{ key: string } | { error: string; status?: number }> {
  const col = boards();
  if (!col) return { error: 'Database not available', status: 500 };
  const upper = typeof key === 'string' ? key.trim().toUpperCase() : '';
  if (!KEY_PATTERN.test(upper)) return { error: 'key must be 2 to 10 letters and digits, starting with a letter' };
  await col.updateOne({ projectId }, { $set: { projectId, key: upper, updatedAt: new Date() } }, { upsert: true });
  return { key: upper };
}

// `count` numbers taken at once, for good (atomically: no other request takes them): the first.
async function takeNumbers(projectId: string, count: number): Promise<number> {
  const board = await boards()!.findOneAndUpdate(
    { projectId }, { $inc: { lastNumber: count } }, { upsert: true, returnDocument: 'after' },
  );
  return (board?.lastNumber ?? count) - count + 1;
}

/**
 * The project's cards without a number given theirs, oldest first. Requests may do it at once (a
 * board reads its sequences' cards together): each card is given a number taken for it alone, and
 * only if it still has none. A number taken by a request that found the card numbered already is
 * never given: numbers may skip, but no two cards share one.
 */
export async function numberCards(projectId: string): Promise<void> {
  if (!boards() || !shots()) return;
  const unnumbered = await shots()!.find({ projectId, number: { $exists: false } }).sort({ createdAt: 1, id: 1 }).toArray();
  for (const card of unnumbered) {
    // Numbered by another request since it was read: no number spent on it.
    if (!(await shots()!.findOne({ projectId, id: card.id, number: { $exists: false } }))) continue;
    const number = await takeNumbers(projectId, 1);
    await shots()!.updateOne({ projectId, id: card.id, number: { $exists: false } }, { $set: { number } });
  }
}

/** The number a new card is given (the cards before it numbered first). */
export async function nextNumber(projectId: string): Promise<number> {
  await numberCards(projectId);
  return takeNumbers(projectId, 1);
}

/** A card's key, as it's answered. */
export const cardKey = (projectKey: string, card: Record<string, any>): string | null =>
  (typeof card.number === 'number' ? `${projectKey}-${card.number}` : null);

/** Whether a card is found by a search: its key or its name holds it, case aside. */
export function matchesSearch(card: { name?: string; key?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return !!card.key?.toLowerCase().includes(q) || !!card.name?.toLowerCase().includes(q);
}

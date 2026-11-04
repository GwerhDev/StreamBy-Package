import { nosqlDb } from '../utils/nosqlDb';

// What a project calls its sequences and shots: a film's are sequences and shots, a game's may be
// sets and assets. Only names: what they are, and do, is the same. Kept in the board's document,
// beside its card key.

export interface ProductionLabels {
  sequence: string;
  sequences: string;
  shot: string;
  shots: string;
}

export const DEFAULT_LABELS: ProductionLabels = { sequence: 'Sequence', sequences: 'Sequences', shot: 'Shot', shots: 'Shots' };
const FIELDS = Object.keys(DEFAULT_LABELS) as (keyof ProductionLabels)[];
const MAX_LABEL = 30;

const boards = () => nosqlDb()?.collection<{ projectId: string; labels?: Partial<ProductionLabels> }>('production_boards') ?? null;

/** What a project calls them: its own names, the defaults for the rest. */
export async function readLabels(projectId: string): Promise<ProductionLabels> {
  const saved = (await boards()?.findOne({ projectId }))?.labels ?? {};
  return Object.fromEntries(FIELDS.map(f => [f, typeof saved[f] === 'string' && saved[f] ? saved[f] : DEFAULT_LABELS[f]])) as unknown as ProductionLabels;
}

/** Its names changed: the ones given (an empty one, or null, is the default again). */
export async function setLabels(projectId: string, body: any): Promise<ProductionLabels | { error: string; status?: number }> {
  const col = boards();
  if (!col) return { error: 'Database not available', status: 500 };
  const unknown = Object.keys(body ?? {}).find(k => !(FIELDS as string[]).includes(k));
  if (unknown) return { error: `${unknown} isn't a name it has (${FIELDS.join(', ')})` };
  const current = (await col.findOne({ projectId }))?.labels ?? {};
  const next: Partial<ProductionLabels> = { ...current };
  for (const field of FIELDS) {
    const value = body?.[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') return { error: `${field} must be a name, or null` };
    const name = (value ?? '').trim();
    if (name.length > MAX_LABEL) return { error: `${field} must be at most ${MAX_LABEL} characters` };
    if (name) next[field] = name; else delete next[field];
  }
  await col.updateOne({ projectId }, { $set: { projectId, labels: next } }, { upsert: true });
  return readLabels(projectId);
}

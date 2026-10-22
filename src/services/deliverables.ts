import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { nosqlDb as db } from '../utils/nosqlDb';

// A deliverable: an asset (or one of its versions) delivered for a production shot or for an
// export. A shot or an export can have several (a render, a model, a cut...).

export interface Deliverable {
  id: string;
  projectId: string;
  assetId: string;
  // A version of the asset; null: the asset as it is, its latest version.
  versionId: string | null;
  // What it's delivered for: a shot or an export, one of them.
  shotId: string | null;
  exportId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

export const deliverablesCollection = () => db()?.collection('deliverables') ?? null;

const strip = ({ _id, ...deliverable }: any): Deliverable => deliverable;

export async function createDeliverable(fields: Omit<Deliverable, 'id' | 'createdAt'>): Promise<Deliverable> {
  const col = deliverablesCollection();
  if (!col) throw new Error('Database not available');
  const deliverable: Deliverable = { id: crypto.randomUUID(), ...fields, createdAt: new Date() };
  await col.insertOne({ _id: new ObjectId(), ...deliverable });
  return deliverable;
}

/** A project's deliverables, of one shot or export if given, newest first. */
export async function listDeliverables(projectId: string, of: { shotId?: string; exportId?: string } = {}): Promise<Deliverable[]> {
  const col = deliverablesCollection();
  if (!col) throw new Error('Database not available');
  const filter: Record<string, string> = { projectId };
  if (of.shotId) filter.shotId = of.shotId;
  if (of.exportId) filter.exportId = of.exportId;
  return (await col.find(filter).sort({ createdAt: -1 }).toArray()).map(strip);
}

/** Removes a deliverable (never its asset). Whether there was one. */
export async function deleteDeliverable(projectId: string, id: string): Promise<boolean> {
  const col = deliverablesCollection();
  if (!col) throw new Error('Database not available');
  return (await col.deleteOne({ projectId, id })).deletedCount > 0;
}

/** Forgets the deliverables of what's gone: an asset, shots, or an export. */
export async function deleteDeliverablesOf(projectId: string, of: { assetId?: string; shotIds?: string[]; exportId?: string }): Promise<void> {
  const col = deliverablesCollection();
  if (!col) return;
  if (of.assetId) await col.deleteMany({ projectId, assetId: of.assetId });
  if (of.shotIds?.length) await col.deleteMany({ projectId, shotId: { $in: of.shotIds } });
  if (of.exportId) await col.deleteMany({ projectId, exportId: of.exportId });
}

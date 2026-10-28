import { nosqlDb } from '../utils/nosqlDb';

/** A deleted project's sequences, shots, tasks, deliverables and its assets' license metadata: only that project's. */
export async function deleteProductionData(projectId: string): Promise<void> {
  const db = nosqlDb();
  if (!db || !projectId) return;
  for (const name of ['production_tasks', 'production_shots', 'production_sequences', 'deliverables', 'asset_rights']) {
    await db.collection(name).deleteMany({ projectId });
  }
}

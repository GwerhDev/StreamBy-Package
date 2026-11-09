import crypto from 'crypto';
import { StorageAdapter } from '../types';
import { nosqlDb } from '../utils/nosqlDb';
import { integrityOf } from '../utils/contentHash';
import { listDeliverables } from './deliverables';
import { deliverableStates } from './deliverableGates';
import { AssetVersion, versionsCollection } from './assetVersions';

// An export's catalog: its ready deliverables, for a build (a game's, a site's) to ask for, as
// Unity Addressables' content catalog does. Each entry has its content hash, its size and an
// immutable URL: the content is copied, by the storage itself, to a key named by its hash
// (`<project>/content/<sha256><ext>`), served to be cached forever. The catalog's own hash
// (served alone as catalog.hash) changes when an entry does, and only then: a build reads the
// hash, and fetches the catalog only when it's not the one it has.
//
// Only a ready deliverable (no gate before it holds it back, see deliverableGates) whose
// content's hash was declared when it was uploaded, and checked by the storage, is in it.
// StreamBy never reads the files: what it doesn't know the hash of stays out, and says why.

export const CATALOG_FORMAT_VERSION = 1;
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
// A content key's name: its sha256, and the extension of the file it was copied from.
export const CONTENT_NAME = /^[0-9a-f]{64}(\.[a-z0-9]{1,16})?$/;

export interface CatalogEntry {
  // The asset's name (its file's): what a build asks for.
  key: string;
  assetId: string;
  version: number;
  contentType: string | null;
  size: number;
  // sha256, hex.
  hash: string;
  // Subresource Integrity, for the build to check what it downloads.
  integrity: string;
  url: string;
}

export interface Catalog {
  formatVersion: typeof CATALOG_FORMAT_VERSION;
  export: string;
  // sha256 of its entries (what they are, not where they're served).
  hash: string;
  entries: CatalogEntry[];
}

export type ExclusionReason = 'blocked' | 'asset-missing' | 'version-missing' | 'other-storage' | 'no-hash' | 'not-uploaded';

/** A deliverable of the export left out of its catalog, and why. */
export interface Excluded {
  deliverableId: string;
  assetId: string;
  reason: ExclusionReason;
}

const REASONS: Record<ExclusionReason, string> = {
  'blocked': 'A gate before it hasn\'t passed',
  'asset-missing': 'Its asset no longer exists',
  'version-missing': 'Its version no longer exists',
  'other-storage': 'Its asset is in a storage connection; only the project\'s own storage is catalogued',
  'no-hash': 'It was uploaded without its SHA-256: upload it again with it',
  'not-uploaded': 'Its upload hasn\'t finished, or the storage has no hash of it matching the declared one',
};
export const exclusionMessage = (reason: ExclusionReason) => REASONS[reason];

export const contentKey = (projectId: string, sha256: string, storageKey: string) => {
  const extension = /\.([a-z0-9]{1,16})$/i.exec(storageKey)?.[1]?.toLowerCase();
  return `${projectId}/content/${sha256}${extension ? `.${extension}` : ''}`;
};

/** The sha256 of a catalog's entries, by what they are: their URLs aren't part of it. */
export function catalogHash(entries: Omit<CatalogEntry, 'url' | 'integrity'>[]): string {
  const canonical = entries.map(e => [e.key, e.assetId, e.version, e.contentType, e.size, e.hash]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const byKey = (a: { key: string; assetId: string }, b: { key: string; assetId: string }) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;

/**
 * Checks a version's content against the storage and copies it to its content key (once: then
 * it's recorded on the version). Its content key, or why it can't be catalogued.
 */
async function contentOf(projectId: string, version: AssetVersion, adapter: StorageAdapter): Promise<{ key: string; size: number } | ExclusionReason> {
  if (!version.sha256) return 'no-hash';
  if (version.content) return version.content;
  if (!adapter.contentInfo || !adapter.copyFile) return 'not-uploaded';
  const stored = await adapter.contentInfo(version.storageKey);
  if (!stored || stored.sha256 !== version.sha256) return 'not-uploaded';
  const key = contentKey(projectId, version.sha256, version.storageKey);
  if (!(await adapter.contentInfo(key))) {
    await adapter.copyFile(version.storageKey, key, { cacheControl: IMMUTABLE_CACHE, ...(version.contentType ? { contentType: version.contentType } : {}) });
  }
  const content = { key, size: stored.size };
  await versionsCollection()?.updateOne({ projectId, versionId: version.versionId }, { $set: { content } });
  return content;
}

/**
 * An export's catalog, and the deliverables left out of it. contentUrl: where a content key is
 * served (a CDN, or StreamBy's content route).
 */
export async function buildCatalog(
  project: any,
  exportMeta: { id: string; name: string },
  adapter: StorageAdapter,
  contentUrl: (key: string) => string,
): Promise<{ catalog: Catalog; excluded: Excluded[] }> {
  const projectId = String(project._id ?? project.id);
  const deliverables = await listDeliverables(projectId, { exportId: exportMeta.id });
  const states = await deliverableStates(project, deliverables);
  const files = nosqlDb()?.collection('storage_files');
  const versions = versionsCollection();

  const entries: CatalogEntry[] = [];
  const excluded: Excluded[] = [];
  const seen = new Set<string>();
  for (const [i, deliverable] of deliverables.entries()) {
    // Newest first: an asset delivered twice is in it as its newest deliverable says.
    if (seen.has(deliverable.assetId)) continue;
    seen.add(deliverable.assetId);
    const out = (reason: ExclusionReason) => excluded.push({ deliverableId: deliverable.id, assetId: deliverable.assetId, reason });
    if (states[i].status !== 'ready') { out('blocked'); continue; }

    const fileDoc: any = files && await files.findOne({ fileId: deliverable.assetId, projectId });
    if (!fileDoc) { out('asset-missing'); continue; }
    const connId = fileDoc.storageConnectionId;
    const conn = connId && (project.storageConnections ?? []).find((c: any) => c.id === connId);
    if (conn && conn.source !== 'builtin') { out('other-storage'); continue; }

    const version = (deliverable.versionId
      ? await versions?.findOne({ projectId, assetId: deliverable.assetId, versionId: deliverable.versionId })
      : (await versions?.find({ projectId, assetId: deliverable.assetId }).sort({ version: -1 }).limit(1).toArray())?.[0]) as AssetVersion | null | undefined;
    if (!version) { out('version-missing'); continue; }

    const content = await contentOf(projectId, version, adapter);
    if (typeof content === 'string') { out(content); continue; }
    entries.push({
      key: fileDoc.displayName ?? version.fileName ?? deliverable.assetId,
      assetId: deliverable.assetId,
      version: version.version,
      contentType: version.contentType ?? fileDoc.contentType ?? null,
      size: content.size,
      hash: version.sha256!,
      integrity: integrityOf(version.sha256!),
      url: contentUrl(content.key),
    });
  }
  entries.sort(byKey);
  return {
    catalog: { formatVersion: CATALOG_FORMAT_VERSION, export: exportMeta.name, hash: catalogHash(entries), entries },
    excluded,
  };
}

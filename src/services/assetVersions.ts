import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { nosqlDb as db } from '../utils/nosqlDb';

// An asset's versions. The asset's own key always holds its current version, so its URL never
// changes when it's replaced (a site that links to it shows the new one, with no deploy).
// Before a new version is uploaded there, the current one is copied to a key of its own,
// `<key without extension>.v<n><extension>`, and recorded as version n: every earlier version
// can still be downloaded.

export interface AssetVersion {
  versionId: string;
  assetId: string;
  projectId: string;
  version: number;
  storageKey: string;
  contentType: string | null;
  fileName: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export const versionsCollection = () => db()?.collection('asset_versions') ?? null;

/** The key an asset's version `n` is archived in, next to the asset's own key. */
export const archivedVersionKey = (assetKey: string, version: number) => {
  const extension = /(\.[^./]*)$/.exec(assetKey)?.[1] ?? '';
  return `${assetKey.slice(0, assetKey.length - extension.length)}.v${version}${extension}`;
};

/** Records the first version of an asset just made (or one made before versions were kept). */
export async function recordFirstVersion(file: {
  fileId: string; projectId: string; storageKey: string; contentType?: string; displayName?: string;
  uploadedBy?: string; createdAt?: Date;
}): Promise<void> {
  const col = versionsCollection();
  if (!col) return;
  if (await col.findOne({ assetId: file.fileId, projectId: file.projectId })) return;
  await col.insertOne({
    _id: new ObjectId(),
    versionId: crypto.randomUUID(),
    assetId: file.fileId,
    projectId: file.projectId,
    version: 1,
    storageKey: file.storageKey,
    contentType: file.contentType ?? null,
    fileName: file.displayName ?? null,
    createdBy: file.uploadedBy ?? null,
    createdAt: file.createdAt ?? new Date(),
  });
}

/**
 * Makes room for a new version of an asset, to be uploaded to its own key: its current version
 * is copied to an archive key first (`copyFile`) and recorded there. If the copy fails nothing
 * changes, and it throws: the current version is never lost.
 */
export async function archiveCurrentVersion(
  file: { fileId: string; projectId: string; storageKey: string; contentType?: string; displayName?: string; uploadedBy?: string; createdAt?: Date },
  upload: { fileName: string; contentType: string; userId: string },
  copyFile: (from: string, to: string) => Promise<void>,
): Promise<AssetVersion> {
  const col = versionsCollection();
  if (!col) throw new Error('Database not available');
  await recordFirstVersion(file);
  const [current] = await col.find({ assetId: file.fileId, projectId: file.projectId }).sort({ version: -1 }).limit(1).toArray();
  const currentVersion: number = current?.version ?? 1;
  const archiveKey = archivedVersionKey(file.storageKey, currentVersion);

  await copyFile(file.storageKey, archiveKey);

  await col.updateOne({ assetId: file.fileId, projectId: file.projectId, version: currentVersion }, { $set: { storageKey: archiveKey } });
  const record: AssetVersion = {
    versionId: crypto.randomUUID(),
    assetId: file.fileId,
    projectId: file.projectId,
    version: currentVersion + 1,
    storageKey: file.storageKey,
    contentType: upload.contentType,
    fileName: upload.fileName,
    createdBy: upload.userId,
    createdAt: new Date(),
  };
  await col.insertOne({ _id: new ObjectId(), ...record });
  return record;
}

/** One of an asset's versions, or null. */
export async function findVersion(projectId: string, assetId: string, versionId: string): Promise<AssetVersion | null> {
  return ((await versionsCollection()?.findOne({ projectId, assetId, versionId })) as AssetVersion | null) ?? null;
}

/** Every key an asset's versions are stored in (its current one included). */
export async function versionStorageKeys(projectId: string, assetId: string, currentKey?: string): Promise<string[]> {
  const versions = ((await versionsCollection()?.find({ projectId, assetId }).toArray()) ?? []) as unknown as AssetVersion[];
  return [...new Set([...(currentKey ? [currentKey] : []), ...versions.map(v => v.storageKey)])];
}

/** Forgets an asset's versions (once their files are deleted). */
export async function deleteVersions(projectId: string, assetId: string): Promise<void> {
  await versionsCollection()?.deleteMany({ projectId, assetId });
}

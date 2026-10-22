import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { nosqlDb as db } from '../utils/nosqlDb';

// An asset's versions. Each one is its own file in storage, so any of them can still be
// downloaded: the first is the asset's original key, and each new one gets a key of its own
// (`<original key without extension>.v<n><extension>`). The asset (its storage_files record)
// points to its latest version.

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

const extensionOf = (name: string) => (name.includes('.') ? `.${name.split('.').pop()!.toLowerCase()}` : '');

/** The key of an asset's version `n`, next to its original. */
export const versionStorageKey = (originalKey: string, version: number, fileName: string) => {
  const base = originalKey.replace(/\.[^./]*$/, '');
  return `${base}.v${version}${extensionOf(fileName)}`;
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

/** A new version of an asset: its own key, recorded as the latest. */
export async function addVersion(
  file: { fileId: string; projectId: string; storageKey: string; contentType?: string; displayName?: string; uploadedBy?: string; createdAt?: Date },
  upload: { fileName: string; contentType: string; userId: string },
): Promise<AssetVersion> {
  const col = versionsCollection();
  if (!col) throw new Error('Database not available');
  await recordFirstVersion(file);
  const [latest] = await col.find({ assetId: file.fileId, projectId: file.projectId }).sort({ version: -1 }).limit(1).toArray();
  const first = await col.findOne({ assetId: file.fileId, projectId: file.projectId, version: 1 });
  const version = (latest?.version ?? 1) + 1;
  const record: AssetVersion = {
    versionId: crypto.randomUUID(),
    assetId: file.fileId,
    projectId: file.projectId,
    version,
    storageKey: versionStorageKey(first?.storageKey ?? file.storageKey, version, upload.fileName),
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

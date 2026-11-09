import { MongoClient, ObjectId } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { updateJob, failJob } from './jobQueue';

function getFilesCollection() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db().collection('storage_files');
}

function getMetadataCollection() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db().collection('media_metadata');
}

function getVersionsCollection() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db().collection('asset_versions');
}

// Infer basic metadata from contentType without external binaries
function inferMetadata(contentType: string, size: number): Record<string, any> {
  const meta: Record<string, any> = {};
  if (contentType.startsWith('image/')) {
    meta.category = 'images';
  } else if (contentType.startsWith('audio/')) {
    meta.category = 'audios';
  } else if (contentType.startsWith('video/')) {
    meta.category = 'videos';
  } else {
    meta.category = '3d-models';
  }
  meta.size = size;
  meta.codec = contentType.split('/')[1] ?? 'unknown';
  return meta;
}

export async function runIngestJob(
  jobId: string,
  fileId: string,
  projectId: string,
): Promise<void> {
  await updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10 });

  try {
    const filesCol = getFilesCollection();
    if (!filesCol) throw new Error('Storage database not available');

    const fileDoc = await filesCol.findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found in project ${projectId}`);

    await updateJob(jobId, { stage: 'extracting-metadata', progress: 40, assetId: fileId });

    const metaCol = getMetadataCollection();
    if (metaCol) {
      const meta = inferMetadata(fileDoc.contentType ?? '', fileDoc.size ?? 0);
      await metaCol.updateOne(
        { assetId: fileId, projectId },
        {
          $set: {
            assetId: fileId,
            projectId,
            codec: meta.codec,
            customTags: {},
            extractedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    await updateJob(jobId, { stage: 'creating-version', progress: 70 });

    const versionsCol = getVersionsCollection();
    // Its upload already recorded the version it's in; only an asset from before versions
    // were kept gets one here.
    if (versionsCol && !(await versionsCol.findOne({ assetId: fileId, projectId, storageKey: fileDoc.storageKey }))) {
      const existing = await versionsCol.countDocuments({ assetId: fileId, projectId });
      await versionsCol.insertOne({
        _id: new ObjectId(),
        versionId: crypto.randomUUID(),
        assetId: fileId,
        projectId,
        version: existing + 1,
        storageKey: fileDoc.storageKey,
        size: fileDoc.size ?? 0,
        createdBy: fileDoc.uploadedBy,
        createdAt: new Date(),
      });
    }

    await updateJob(jobId, { status: 'completed', stage: 'complete', progress: 100 });
  } catch (err: any) {
    await failJob(jobId, err.message);
  }
}

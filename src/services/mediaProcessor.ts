import { MongoClient, ObjectId } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { StorageAdapter } from '../types';
import { createJob, updateJob, failJob } from './jobQueue';

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
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10 });

  try {
    const filesCol = getFilesCollection();
    if (!filesCol) throw new Error('Storage database not available');

    const fileDoc = await filesCol.findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found in project ${projectId}`);

    updateJob(jobId, { stage: 'extracting-metadata', progress: 40, assetId: fileId });

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

    updateJob(jobId, { stage: 'creating-version', progress: 70 });

    const versionsCol = getVersionsCollection();
    if (versionsCol) {
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

    updateJob(jobId, { status: 'completed', stage: 'complete', progress: 100 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function runTranscodeJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: {
    codec?: string;
    resolution?: string;
    outputFormat?: string;
    bitrate?: string;
    audioCodec?: string;
  },
  _adapter: StorageAdapter,
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'queued', progress: 5, assetId: fileId });

  try {
    const filesCol = getFilesCollection();
    if (!filesCol) throw new Error('Storage database not available');

    const fileDoc = await filesCol.findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    if (!fileDoc.contentType?.startsWith('video/') && !fileDoc.contentType?.startsWith('audio/')) {
      throw new Error('Transcode only supports video and audio files');
    }

    updateJob(jobId, { stage: 'transcoding', progress: 20 });

    // Store the transcode request as a pending task — actual FFmpeg execution
    // happens in the host environment (Nhexa-API worker). The job record is the
    // handoff contract: the worker reads it, processes the file, and calls back
    // to update progress via the job queue.
    const metaCol = getMetadataCollection();
    if (metaCol) {
      await metaCol.updateOne(
        { assetId: fileId, projectId },
        {
          $set: {
            assetId: fileId,
            projectId,
            pendingTranscode: {
              codec: options.codec ?? 'h264',
              resolution: options.resolution ?? 'original',
              outputFormat: options.outputFormat ?? 'mp4',
              bitrate: options.bitrate,
              audioCodec: options.audioCodec ?? 'aac',
              requestedAt: new Date(),
            },
            customTags: {},
            extractedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    updateJob(jobId, { stage: 'pending-worker', progress: 30 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function runThumbnailJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: { timecode?: string; resolution?: string; strategy?: string },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const filesCol = getFilesCollection();
    if (!filesCol) throw new Error('Storage database not available');

    const fileDoc = await filesCol.findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    updateJob(jobId, { stage: 'pending-worker', progress: 30 });

    const metaCol = getMetadataCollection();
    if (metaCol) {
      await metaCol.updateOne(
        { assetId: fileId, projectId },
        {
          $set: {
            assetId: fileId,
            projectId,
            pendingThumbnail: {
              timecode: options.timecode ?? '00:00:01',
              resolution: options.resolution ?? '1280x720',
              strategy: options.strategy ?? 'timecode',
              requestedAt: new Date(),
            },
            customTags: {},
            extractedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    updateJob(jobId, { stage: 'pending-worker', progress: 40 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function runCaptionJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: { sourceLanguage?: string; outputFormat?: string; provider?: string },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const filesCol = getFilesCollection();
    if (!filesCol) throw new Error('Storage database not available');

    const fileDoc = await filesCol.findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    if (!fileDoc.contentType?.startsWith('video/') && !fileDoc.contentType?.startsWith('audio/')) {
      throw new Error('Captions only support video and audio files');
    }

    const metaCol = getMetadataCollection();
    if (metaCol) {
      await metaCol.updateOne(
        { assetId: fileId, projectId },
        {
          $set: {
            assetId: fileId,
            projectId,
            pendingCaption: {
              sourceLanguage: options.sourceLanguage ?? 'auto',
              outputFormat: options.outputFormat ?? 'srt',
              provider: options.provider ?? 'manual',
              requestedAt: new Date(),
            },
            customTags: {},
            extractedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    updateJob(jobId, { stage: 'pending-worker', progress: 30 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

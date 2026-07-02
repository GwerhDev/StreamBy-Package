import { MongoClient, ObjectId } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { updateJob, failJob } from './jobQueue';

function getNosqlDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

export async function runRenderJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: {
    renderer?: string;
    renderFarmConnectionId?: string;
    frameRange?: string;
    resolution?: string;
    samples?: number;
    outputFormat?: string;
  },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const db = getNosqlDb();
    if (!db) throw new Error('Storage database not available');

    const fileDoc = await db.collection('storage_files').findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    updateJob(jobId, { stage: 'queued-farm', progress: 20 });

    // Store pending render task — picked up by the host render farm worker
    await db.collection('media_metadata').updateOne(
      { assetId: fileId, projectId },
      {
        $set: {
          assetId: fileId,
          projectId,
          pendingRender: {
            renderer: options.renderer ?? 'blender',
            renderFarmConnectionId: options.renderFarmConnectionId,
            frameRange: options.frameRange ?? '1-1',
            resolution: options.resolution ?? '1920x1080',
            samples: options.samples ?? 128,
            outputFormat: options.outputFormat ?? 'png',
            requestedAt: new Date(),
          },
          customTags: {},
          extractedAt: new Date(),
        },
      },
      { upsert: true },
    );

    updateJob(jobId, { stage: 'pending-worker', progress: 30 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function runFormatConvertJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: {
    inputFormat?: string;
    outputFormat?: string;
    applyTransforms?: boolean;
    embedTextures?: boolean;
  },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const db = getNosqlDb();
    if (!db) throw new Error('Storage database not available');

    const fileDoc = await db.collection('storage_files').findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    updateJob(jobId, { stage: 'queued-convert', progress: 25 });

    await db.collection('media_metadata').updateOne(
      { assetId: fileId, projectId },
      {
        $set: {
          assetId: fileId,
          projectId,
          pendingFormatConvert: {
            inputFormat: options.inputFormat ?? 'fbx',
            outputFormat: options.outputFormat ?? 'glb',
            applyTransforms: options.applyTransforms ?? true,
            embedTextures: options.embedTextures ?? true,
            requestedAt: new Date(),
          },
          customTags: {},
          extractedAt: new Date(),
        },
      },
      { upsert: true },
    );

    updateJob(jobId, { stage: 'pending-worker', progress: 35 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function runLodJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: {
    levels?: number;
    reductionRatios?: number[];
    algorithm?: string;
    outputFormat?: string;
  },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const db = getNosqlDb();
    if (!db) throw new Error('Storage database not available');

    const fileDoc = await db.collection('storage_files').findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    updateJob(jobId, { stage: 'queued-lod', progress: 25 });

    await db.collection('media_metadata').updateOne(
      { assetId: fileId, projectId },
      {
        $set: {
          assetId: fileId,
          projectId,
          pendingLod: {
            levels: options.levels ?? 3,
            reductionRatios: options.reductionRatios ?? [0.5, 0.25, 0.1],
            algorithm: options.algorithm ?? 'quadric',
            outputFormat: options.outputFormat ?? 'glb',
            requestedAt: new Date(),
          },
          customTags: {},
          extractedAt: new Date(),
        },
      },
      { upsert: true },
    );

    updateJob(jobId, { stage: 'pending-worker', progress: 30 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function resolveAssetDependencyGraph(
  projectId: string,
  rootAssetId: string,
  maxDepth: number = 5,
): Promise<{ nodes: any[]; edges: any[] }> {
  const db = getNosqlDb();
  if (!db) return { nodes: [], edges: [] };

  const filesCol = db.collection('storage_files');
  const visited = new Set<string>();
  const nodes: { assetId: string; type: string; resolved: boolean }[] = [];
  const edges: { from: string; to: string; relationship: string }[] = [];

  async function walk(assetId: string, depth: number) {
    if (depth > maxDepth || visited.has(assetId)) return;
    visited.add(assetId);

    const file = await filesCol.findOne({ fileId: assetId, projectId });
    nodes.push({
      assetId,
      type: file?.contentType ?? 'unknown',
      resolved: !!file,
    });

    // Dependencies are stored as a `dependencies` array on the file document
    const deps: string[] = file?.dependencies ?? [];
    for (const depId of deps) {
      edges.push({ from: assetId, to: depId, relationship: 'depends-on' });
      await walk(depId, depth + 1);
    }
  }

  await walk(rootAssetId, 0);

  await db.collection('asset_dependency_graphs').updateOne(
    { rootAssetId, projectId },
    { $set: { rootAssetId, projectId, nodes, edges, resolvedAt: new Date() } },
    { upsert: true },
  );

  return { nodes, edges };
}

import { MongoClient } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { updateJob, failJob } from './jobQueue';
import { PipelineSuggestion } from '../types';

function getNosqlDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

export async function runTranscriptionJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: { model?: string; sourceLanguage?: string; outputFormats?: string[]; provider?: string; credentialId?: string },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const db = getNosqlDb();
    if (!db) throw new Error('Storage database not available');

    const fileDoc = await db.collection('storage_files').findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    if (!fileDoc.contentType?.startsWith('video/') && !fileDoc.contentType?.startsWith('audio/')) {
      throw new Error('Transcription only supports video and audio files');
    }

    updateJob(jobId, { stage: 'queued-provider', progress: 20 });

    await db.collection('media_metadata').updateOne(
      { assetId: fileId, projectId },
      {
        $set: {
          assetId: fileId,
          projectId,
          pendingTranscription: {
            model: options.model ?? 'whisper-1',
            sourceLanguage: options.sourceLanguage ?? 'auto',
            outputFormats: options.outputFormats ?? ['srt', 'vtt'],
            provider: options.provider ?? 'openai',
            credentialId: options.credentialId,
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

export async function runUpscaleJob(
  jobId: string,
  fileId: string,
  projectId: string,
  options: { scale?: number; model?: string; mode?: 'images' | 'video'; credentialId?: string },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'resolving', progress: 10, assetId: fileId });

  try {
    const db = getNosqlDb();
    if (!db) throw new Error('Storage database not available');

    const fileDoc = await db.collection('storage_files').findOne({ fileId, projectId });
    if (!fileDoc) throw new Error(`File ${fileId} not found`);

    updateJob(jobId, { stage: 'queued-upscale', progress: 20 });

    await db.collection('media_metadata').updateOne(
      { assetId: fileId, projectId },
      {
        $set: {
          assetId: fileId,
          projectId,
          pendingUpscale: {
            scale: options.scale ?? 4,
            model: options.model ?? 'real-esrgan',
            mode: options.mode ?? 'images',
            credentialId: options.credentialId,
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

export async function runGenerateAssetJob(
  jobId: string,
  projectId: string,
  options: {
    assetType?: 'mesh' | 'texture' | 'audio';
    provider?: string;
    prompt: string;
    seed?: number;
    credentialId?: string;
  },
): Promise<void> {
  updateJob(jobId, { status: 'processing', stage: 'queued-generation', progress: 10 });

  try {
    const db = getNosqlDb();
    if (!db) throw new Error('Storage database not available');

    await db.collection('generative_jobs').insertOne({
      jobId,
      projectId,
      assetType: options.assetType ?? 'mesh',
      provider: options.provider ?? 'meshy',
      prompt: options.prompt,
      seed: options.seed,
      credentialId: options.credentialId,
      status: 'pending',
      requestedAt: new Date(),
    });

    updateJob(jobId, { stage: 'pending-worker', progress: 20 });
  } catch (err: any) {
    failJob(jobId, err.message);
  }
}

export async function buildPipelineSuggestion(
  nodeSchema: { nodes: any[]; edges: any[] },
  availableNodeTypes: string[],
): Promise<PipelineSuggestion> {
  const presentTypes = new Set(nodeSchema.nodes.map((n: any) => n.type));

  // Heuristic rules — replaced by LLM call in the host environment
  const suggestions: PipelineSuggestion['nodesToAdd'] = [];
  const edgeSuggestions: PipelineSuggestion['edgesToAdd'] = [];

  const hasVideo = nodeSchema.nodes.some((n: any) =>
    ['ingestNode', 'transcodeNode'].includes(n.type),
  );

  if (hasVideo && !presentTypes.has('captionNode') && availableNodeTypes.includes('captionNode')) {
    suggestions.push({ type: 'captionNode', label: 'Captions', position: { x: 600, y: 100 } });
  }

  if (hasVideo && !presentTypes.has('thumbnailNode') && availableNodeTypes.includes('thumbnailNode')) {
    suggestions.push({ type: 'thumbnailNode', label: 'Thumbnail', position: { x: 600, y: 250 } });
  }

  if (!presentTypes.has('qcCheckNode') && availableNodeTypes.includes('qcCheckNode')) {
    suggestions.push({ type: 'qcCheckNode', label: 'QC Check', position: { x: 400, y: -150 } });
  }

  const rationale =
    suggestions.length > 0
      ? `Detected ${suggestions.map(s => s.label).join(', ')} as missing steps for a complete pipeline.`
      : 'Pipeline looks complete for the current asset types.';

  return { rationale, nodesToAdd: suggestions, edgesToAdd: edgeSuggestions };
}

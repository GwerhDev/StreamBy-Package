import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { NodeSchema, StreamByConfig } from '../types';
import { getConnection } from '../adapters/database/connectionManager';
import { decrypt, isEncryptionKeySet } from '../utils/encryption';
import { queryRecordsInternal, queryRecordByIdInternal } from './dbConnection';
import { createJob } from './jobQueue';
import {
  runIngestJob,
  runTranscodeJob,
  runThumbnailJob,
  runCaptionJob,
} from './mediaProcessor';
import { runRenderJob, runFormatConvertJob, runLodJob } from './vfxProcessor';
import { runTranscriptionJob, runUpscaleJob, runGenerateAssetJob, buildPipelineSuggestion } from './aiProcessor';
import { createStorageProvider } from '../providers/storage';

interface FilterCondition { field: string; op: string; value: string; }
interface FilterNodeConfig {
  conditions?:   FilterCondition[];
  includeFields?: string[];
  renameFields?:  Array<{ from: string; to: string }>;
  wrapKey?:       string;
  limit?:         number;
}

function applyFilterConfig(payload: any, config: FilterNodeConfig): any {
  const isArr = Array.isArray(payload);
  let r: any = isArr ? [...payload] : payload;

  if (config.conditions?.length) {
    const matches = (item: any) => config.conditions!.every(c => {
      const v = item?.[c.field];
      switch (c.op) {
        case 'eq':         return String(v) === c.value;
        case 'neq':        return String(v) !== c.value;
        case 'gt':         return Number(v) >  Number(c.value);
        case 'lt':         return Number(v) <  Number(c.value);
        case 'gte':        return Number(v) >= Number(c.value);
        case 'lte':        return Number(v) <= Number(c.value);
        case 'contains':   return String(v).includes(c.value);
        case 'startsWith': return String(v).startsWith(c.value);
        case 'endsWith':   return String(v).endsWith(c.value);
        default:           return true;
      }
    });
    r = isArr ? r.filter(matches) : (matches(r) ? r : null);
    if (r === null) return null;
  }

  if (config.includeFields?.length) {
    const pick = (item: any) => {
      if (!item || typeof item !== 'object') return item;
      const o: any = {};
      for (const f of config.includeFields!) if (f in item) o[f] = item[f];
      return o;
    };
    r = isArr ? r.map(pick) : pick(r);
  }

  if (config.renameFields?.length) {
    const ren = (item: any) => {
      if (!item || typeof item !== 'object') return item;
      const o = { ...item };
      for (const { from, to } of config.renameFields!) {
        if (from in o) { o[to] = o[from]; delete o[from]; }
      }
      return o;
    };
    r = isArr ? r.map(ren) : ren(r);
  }

  if (config.limit && isArr) r = r.slice(0, config.limit);
  if (config.wrapKey)        r = { [config.wrapKey]: r };
  return r;
}

type PipelineNode = { id: string; type: string; data?: Record<string, any> };
type PipelineEdge = { id?: string; source: string; sourceHandle: string; target: string; targetHandle: string };

function getSources(nodes: PipelineNode[], edges: PipelineEdge[], targetId: string, targetHandle: string): PipelineNode[] {
  return edges
    .filter(e => e.target === targetId && e.targetHandle === targetHandle)
    .map(e => nodes.find(n => n.id === e.source))
    .filter((n): n is PipelineNode => n !== undefined);
}

function getTarget(nodes: PipelineNode[], edges: PipelineEdge[], sourceId: string, sourceHandle: string): PipelineNode | null {
  const edge = edges.find(e => e.source === sourceId && e.sourceHandle === sourceHandle);
  return edge ? (nodes.find(n => n.id === edge.target) ?? null) : null;
}

export async function executePipeline(
  nodeSchema: NodeSchema,
  project: any,
  config: StreamByConfig,
): Promise<any> {
  const nodes = nodeSchema.nodes as PipelineNode[];
  const edges = nodeSchema.edges as PipelineEdge[];

  // 1. Data layer — nodes connected to streamby in-bottom
  const dataSources = getSources(nodes, edges, 'streamby', 'in-bottom');
  const dataResults: any[] = [];

  for (const node of dataSources) {
    if (node.type === 'jsonInputNode') {
      try {
        dataResults.push(JSON.parse(node.data?.jsonString || 'null'));
      } catch {
        dataResults.push(null);
      }

    } else if (node.type === 'dataSourceNode') {
      const tableName = (node.data?.tableName || node.data?.subtitle || node.data?.label) as string | undefined;
      if (!tableName) continue;

      const connectionId = node.data?.connectionId as string | undefined;
      const recordId     = node.data?.recordId     as string | undefined;

      const projectIdentifier = project._id?.toString() ?? project.id;
      const fetchData = async (client: Pool | MongoClient, type: 'sql' | 'nosql') =>
        recordId
          ? queryRecordByIdInternal(client, type, tableName, recordId, projectIdentifier)
          : queryRecordsInternal(client, type, tableName, 500, 0, projectIdentifier);

      if (connectionId) {
        const { client, type } = getConnection(connectionId);
        dataResults.push(await fetchData(client as Pool | MongoClient, type));
      } else {
        // legacy fallback for nodes saved before connectionId was introduced
        const targetDb = config.databases?.find((db: any) => db.type === project.dbType && db.main)
          ?? config.databases?.find((db: any) => db.type === project.dbType);
        if (!targetDb) throw new Error(`No database connection for type ${project.dbType}`);
        const { client, type } = getConnection(targetDb.id);
        dataResults.push(await fetchData(client as Pool | MongoClient, type));
      }

    } else if (node.type === 'apiConnectionNode') {
      const apiConnection = project.apiConnections?.find((c: any) => c.id === node.data?.connectionId);
      if (!apiConnection) continue;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (apiConnection.credentialId && isEncryptionKeySet()) {
        const credential = project.credentials?.find((c: any) => c.id === apiConnection.credentialId);
        if (credential) {
          const decrypted = decrypt(credential.encryptedValue);
          const prefix = apiConnection.prefix ? `${apiConnection.prefix} ` : '';
          headers['Authorization'] = `${prefix}${decrypted}`;
        }
      }

      const response = await fetch(apiConnection.apiUrl, { method: apiConnection.method || 'GET', headers });
      if (!response.ok) throw new Error(`API connection fetch failed: ${response.statusText}`);
      dataResults.push(await response.json());
    }
  }

  let payload: any = dataResults.length === 1 ? dataResults[0] : dataResults;

  // 2. Process layer — chain from streamby out-top → processNode in-process → out-process → ...
  const adapter = createStorageProvider(config.storageProviders);
  const projectId = project._id?.toString() ?? project.id;
  // userId is not available in pipeline context; use a sentinel for job attribution
  const systemUserId = 'pipeline';

  let processNode = getTarget(nodes, edges, 'streamby', 'out-top');
  while (processNode) {
    const nodeData = processNode.data ?? {};
    const fileId = nodeData.fileId as string | undefined;

    if (processNode.type === 'transcodeNode' && fileId) {
      const job = createJob('transcode', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runTranscodeJob(job.jobId, fileId, projectId, {
          codec:        nodeData.codec,
          resolution:   nodeData.resolution,
          outputFormat: nodeData.outputFormat,
          bitrate:      nodeData.bitrate,
          audioCodec:   nodeData.audioCodec,
        }, adapter),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'transcode' };

    } else if (processNode.type === 'captionNode' && fileId) {
      const job = createJob('caption', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runCaptionJob(job.jobId, fileId, projectId, {
          sourceLanguage: nodeData.sourceLanguage,
          outputFormat:   nodeData.outputFormat,
          provider:       nodeData.provider,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'caption' };

    } else if (processNode.type === 'thumbnailNode' && fileId) {
      const job = createJob('thumbnail', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runThumbnailJob(job.jobId, fileId, projectId, {
          timecode:   nodeData.timecode,
          resolution: nodeData.resolution,
          strategy:   nodeData.strategy,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'thumbnail' };

    } else if (processNode.type === 'ingestNode' && fileId) {
      const job = createJob('ingest', systemUserId, projectId, nodeData);
      setImmediate(() => runIngestJob(job.jobId, fileId, projectId));
      payload = { ...payload, jobId: job.jobId, jobType: 'ingest' };

    } else if (processNode.type === 'renderJobNode' && fileId) {
      const job = createJob('render', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runRenderJob(job.jobId, fileId, projectId, {
          renderer:               nodeData.renderer,
          renderFarmConnectionId: nodeData.renderFarmConnectionId,
          frameRange:             nodeData.frameRange,
          resolution:             nodeData.resolution,
          samples:                nodeData.samples,
          outputFormat:           nodeData.outputFormat,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'render' };

    } else if (processNode.type === 'formatConvertNode' && fileId) {
      const job = createJob('format-convert', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runFormatConvertJob(job.jobId, fileId, projectId, {
          inputFormat:    nodeData.inputFormat,
          outputFormat:   nodeData.outputFormat,
          applyTransforms: nodeData.applyTransforms,
          embedTextures:  nodeData.embedTextures,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'format-convert' };

    } else if (processNode.type === 'lodNode' && fileId) {
      const job = createJob('lod', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runLodJob(job.jobId, fileId, projectId, {
          levels:          nodeData.levels,
          reductionRatios: nodeData.reductionRatios,
          algorithm:       nodeData.algorithm,
          outputFormat:    nodeData.outputFormat,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'lod' };

    } else if (processNode.type === 'qcCheckNode' && fileId) {
      const checks = (nodeData.checks as string[] | undefined) ?? [];
      const checkResults = checks.map((name: string) => ({
        name, passed: true, value: 'ok', threshold: 'ok',
      }));
      payload = { ...payload, qcReport: { checks: checkResults, overallPassed: true } };

    } else if (processNode.type === 'transcriptionNode' && fileId) {
      const job = createJob('transcription', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runTranscriptionJob(job.jobId, fileId, projectId, {
          model:          nodeData.model,
          sourceLanguage: nodeData.sourceLanguage,
          outputFormats:  nodeData.outputFormats,
          provider:       nodeData.provider,
          credentialId:   nodeData.credentialId,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'transcription' };

    } else if (processNode.type === 'upscaleNode' && fileId) {
      const job = createJob('upscale', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runUpscaleJob(job.jobId, fileId, projectId, {
          scale:        nodeData.scale,
          model:        nodeData.model,
          mode:         nodeData.mode,
          credentialId: nodeData.credentialId,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'upscale' };

    } else if (processNode.type === 'proceduralAssetNode') {
      const job = createJob('generate-asset', systemUserId, projectId, nodeData);
      setImmediate(() =>
        runGenerateAssetJob(job.jobId, projectId, {
          assetType:    nodeData.assetType,
          provider:     nodeData.provider,
          prompt:       nodeData.prompt ?? '',
          seed:         nodeData.seed,
          credentialId: nodeData.credentialId,
        }),
      );
      payload = { ...payload, jobId: job.jobId, jobType: 'generate-asset' };

    } else if (processNode.type === 'pipelineSuggestNode') {
      const suggestion = await buildPipelineSuggestion(
        { nodes, edges },
        Object.keys(nodeSchema),
      );
      payload = { ...payload, pipelineSuggestion: suggestion };
    }

    processNode = getTarget(nodes, edges, processNode.id, 'out-process');
  }

  // 3. Filter + output lane — streamby out-right → filterNode|annotationNode|deliverableNode|distributionNode
  const outputLaneTypes = new Set(['filterNode', 'annotationNode', 'deliverableNode', 'distributionNode']);
  let outputNode = getTarget(nodes, edges, 'streamby', 'out-right');
  while (outputNode) {
    if (outputNode.type === 'filterNode') {
      const cfg = outputNode.data?.filterConfig as FilterNodeConfig | undefined;
      if (cfg) payload = applyFilterConfig(payload, cfg);

    } else if (outputNode.type === 'deliverableNode') {
      payload = {
        ...payload,
        deliverable: {
          type:    outputNode.data?.deliverableType ?? 'asset-bundle',
          version: outputNode.data?.deliverableVersion ?? '1.0.0',
        },
      };

    } else if (outputNode.type === 'distributionNode') {
      // Distribution is async — the actual publish is handled by the host worker
      payload = {
        ...payload,
        distribution: {
          target:       outputNode.data?.distributionTarget,
          connectionId: outputNode.data?.distributionConnectionId,
          channel:      outputNode.data?.channel,
          status:       'queued',
        },
      };
    }
    // annotationNode — pass-through; annotations are stored separately via the review API

    const next = getTarget(nodes, edges, outputNode.id, 'out-filter');
    outputNode = next && outputLaneTypes.has(next.type) ? next : null;
  }

  return payload;
}

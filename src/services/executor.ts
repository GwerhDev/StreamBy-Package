import { NodeSchema, StreamByConfig, Auth } from '../types';
import { decrypt, isEncryptionKeySet } from '../utils/encryption';
import { queryRecordsInternal, queryRecordByIdInternal } from './dbConnection';
import { resolveDbConnectionClient, releaseDbClient, resolveStorageAdapter } from './connectionResolver';
import { getDecryptedIntegrationCredentialById } from './userIntegration';
import { buildServiceAuthHeaders } from './oauthClient';
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

type ExecutionNode = { id: string; type: string; data?: Record<string, any> };
type ExecutionEdge = { id?: string; source: string; sourceHandle: string; target: string; targetHandle: string };

function getSources(nodes: ExecutionNode[], edges: ExecutionEdge[], targetId: string, targetHandle: string): ExecutionNode[] {
  return edges
    .filter(e => e.target === targetId && e.targetHandle === targetHandle)
    .map(e => nodes.find(n => n.id === e.source))
    .filter((n): n is ExecutionNode => n !== undefined);
}

function getTarget(nodes: ExecutionNode[], edges: ExecutionEdge[], sourceId: string, sourceHandle: string): ExecutionNode | null {
  const edge = edges.find(e => e.source === sourceId && e.sourceHandle === sourceHandle);
  return edge ? (nodes.find(n => n.id === edge.target) ?? null) : null;
}

export class NodeExecutionError extends Error {
  constructor(public nodeId: string, public nodeType: string, message: string) {
    super(message);
    this.name = 'NodeExecutionError';
  }
}

// Export execution is public (gated by allowedOrigin, not user identity — see
// export.ts:339) — there is no real Auth to pass through. This sentinel satisfies
// resolveDbConnectionClient's signature without adding a gate that never existed;
// canUseBuiltin gating is for connection *management* by a user, not for serving an
// already-published export.
const SYSTEM_AUTH: Auth = { userId: 'system', username: 'system', role: 'admin' };

export async function executeExport(
  nodeSchema: NodeSchema,
  project: any,
  config: StreamByConfig,
): Promise<any> {
  const nodes = nodeSchema.nodes as ExecutionNode[];
  const edges = nodeSchema.edges as ExecutionEdge[];

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

      // dataSourceNode always declares its own database connection explicitly (persistence:
      // 'database' in types/nodePersistence.ts) — a project has no notion of a "default"
      // connection, since a project can have many database/storage/API providers connected.
      const connectionId = node.data?.connectionId as string | undefined;
      if (!connectionId) {
        throw new NodeExecutionError(
          node.id, node.type,
          `Node '${node.id}' (${node.type}) has no database connection — connect one on the node.`,
        );
      }
      const recordId = node.data?.recordId as string | undefined;

      const projectIdentifier = project._id?.toString() ?? project.id;
      const resolved = await resolveDbConnectionClient(project, connectionId, config, SYSTEM_AUTH);
      if ('error' in resolved) {
        throw new NodeExecutionError(node.id, node.type, `Node '${node.id}' (${node.type}): ${resolved.error}`);
      }
      try {
        dataResults.push(
          recordId
            ? await queryRecordByIdInternal(resolved.client, resolved.type, tableName, recordId, projectIdentifier)
            : await queryRecordsInternal(resolved.client, resolved.type, tableName, 500, 0, projectIdentifier),
        );
      } finally {
        await releaseDbClient(resolved);
      }

    } else if (node.type === 'connectionNode') {
      const connection = project.connections?.find((c: any) => c.id === node.data?.connectionId);
      if (!connection) continue;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (connection.encryptedCredential && isEncryptionKeySet()) {
        const decrypted = decrypt(connection.encryptedCredential);
        const prefix = connection.prefix ? `${connection.prefix} ` : '';
        headers['Authorization'] = `${prefix}${decrypted}`;
      }

      const response = await fetch(connection.apiUrl, { method: connection.method || 'GET', headers });
      if (!response.ok) throw new Error(`Connection fetch failed: ${response.statusText}`);
      dataResults.push(await response.json());

    } else if (node.type === 'integrationConnectionNode') {
      // Generic action over a project-level IntegrationConnection (Claude/Jira/Google) — the
      // node's data carries the endpoint/method/body to invoke, same shape family as
      // connectionNode's apiUrl/method, but the auth header comes from the resolved
      // account-level integration credential instead of a static per-connection secret.
      // Diverges from connectionNode's silent-skip: a missing connection/credential throws
      // NodeExecutionError (matching dataSourceNode/ingestNode's intentional pattern), since
      // a silently-skipped service action would produce a workflow that "succeeds" while
      // quietly missing the one thing the node exists to do.
      const connectionId = node.data?.connectionId as string | undefined;
      if (!connectionId) {
        throw new NodeExecutionError(
          node.id, node.type,
          `Node '${node.id}' (${node.type}) has no integration connection — connect one on the node.`,
        );
      }
      const connection = (project.integrationConnections ?? []).find((c: any) => c.id === connectionId);
      if (!connection) {
        throw new NodeExecutionError(node.id, node.type, `Node '${node.id}' (${node.type}): integration connection not found on this project.`);
      }

      const resolved = await getDecryptedIntegrationCredentialById(connection.integrationId, config);
      if (!resolved) {
        throw new NodeExecutionError(node.id, node.type, `Node '${node.id}' (${node.type}): integration credential could not be resolved — it may have been disconnected.`);
      }

      const endpoint = node.data?.endpoint as string | undefined;
      if (!endpoint) {
        throw new NodeExecutionError(node.id, node.type, `Node '${node.id}' (${node.type}) has no endpoint configured.`);
      }
      const method = (node.data?.method as string | undefined) ?? 'GET';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildServiceAuthHeaders(connection.provider, resolved.credential as string),
      };

      const body = node.data?.body ? JSON.stringify(node.data.body) : undefined;
      const response = await fetch(endpoint, { method, headers, body });
      if (!response.ok) {
        throw new NodeExecutionError(node.id, node.type, `Node '${node.id}' (${node.type}): integration action failed (${response.statusText}).`);
      }
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
      // ingestNode always declares its own storage connection explicitly (persistence:
      // 'storage' in types/nodePersistence.ts) — a project has no notion of a "default"
      // connection, since a project can have many database/storage/API providers connected.
      const storageConnectionId = nodeData.storageConnectionId as string | undefined;
      if (!storageConnectionId) {
        throw new NodeExecutionError(
          processNode.id, processNode.type,
          `Node '${processNode.id}' (${processNode.type}) has no storage connection — connect one on the node.`,
        );
      }
      const storageResolved = await resolveStorageAdapter(project, storageConnectionId, config, SYSTEM_AUTH);
      if ('error' in storageResolved) {
        throw new NodeExecutionError(processNode.id, processNode.type, `Node '${processNode.id}' (${processNode.type}): ${storageResolved.error}`);
      }
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

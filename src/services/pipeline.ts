import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { NodeSchema, StreamByConfig } from '../types';
import { getConnection } from '../adapters/database/connectionManager';
import { decrypt, isEncryptionKeySet } from '../utils/encryption';
import { queryRecordsInternal } from './dbConnection';

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

      if (connectionId) {
        const { client, type } = getConnection(connectionId);
        const records = await queryRecordsInternal(client as Pool | MongoClient, type, tableName, 500, 0, project.id);
        dataResults.push(records);
      } else {
        // legacy fallback for nodes saved before connectionId was introduced
        const targetDb = config.databases?.find((db: any) => db.type === project.dbType && db.main)
          ?? config.databases?.find((db: any) => db.type === project.dbType);
        if (!targetDb) throw new Error(`No database connection for type ${project.dbType}`);
        const { client, type } = getConnection(targetDb.id);
        const records = await queryRecordsInternal(client as Pool | MongoClient, type, tableName, 500, 0, project.id);
        dataResults.push(records);
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
  let processNode = getTarget(nodes, edges, 'streamby', 'out-top');
  while (processNode) {
    // transform/auth/custom logic per processNode.data.label — pass-through until defined
    processNode = getTarget(nodes, edges, processNode.id, 'out-process');
  }

  // 3. Filter layer — chain from streamby out-right → filterNode in-filter → out-filter → ...
  let filterNode = getTarget(nodes, edges, 'streamby', 'out-right');
  while (filterNode) {
    const cfg = filterNode.data?.filterConfig as FilterNodeConfig | undefined;
    if (cfg) payload = applyFilterConfig(payload, cfg);
    filterNode = getTarget(nodes, edges, filterNode.id, 'out-filter');
  }

  return payload;
}

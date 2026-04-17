import { MongoClient } from 'mongodb';
import { NodeSchema, StreamByConfig } from '../types';
import { getConnection } from '../adapters/database/connectionManager';
import { decrypt, isEncryptionKeySet } from '../utils/encryption';

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
      const collectionName = node.data?.subtitle || node.data?.label;
      if (!collectionName) continue;

      const targetDb = config.databases?.find(db => db.type === project.dbType && db.main)
        ?? config.databases?.find(db => db.type === project.dbType);

      if (!targetDb) throw new Error(`No database connection for type ${project.dbType}`);

      const connection = getConnection(targetDb.id);
      const db = (connection.client as MongoClient).db();
      dataResults.push(await db.collection(collectionName).find({}).toArray());

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
    // filter logic per filterNode.data.label — pass-through until defined
    filterNode = getTarget(nodes, edges, filterNode.id, 'out-filter');
  }

  return payload;
}

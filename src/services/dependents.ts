import { nosqlDb } from '../utils/nosqlDb';
import { resourceOfNode } from './workflowResources';

// What depends on one of a project's resources (a connection, an export, a pipeline), told
// before it's removed: the nodes that use it (in the workflow, the exports, the pipelines) and
// the data kept in or for it. Removing the resource changes none of them: a node keeps
// pointing at it (and fails when it runs), the data stays where it is.

export type ResourceKind = 'db' | 'api' | 'storage' | 'service' | 'export' | 'pipeline';
export const RESOURCE_KINDS: ResourceKind[] = ['db', 'api', 'storage', 'service', 'export', 'pipeline'];

export interface Dependent {
  // Where it is: a node of the workflow, of an export or of a pipeline; or data kept for it.
  type: 'workflow' | 'export' | 'pipeline' | 'files' | 'folders' | 'deliverables' | 'shots';
  name: string;
  id?: string;
  count?: number;
}

// The node data fields that point at each kind of resource.
const FIELDS: Record<ResourceKind, string[]> = {
  db: ['connectionId'],
  api: ['connectionId'],
  storage: ['storageConnectionId'],
  service: ['integrationConnectionId'],
  export: ['exportId'],
  pipeline: ['pipelineId'],
};

// A resource's own node in the workflow isn't a dependent of it: its other nodes using it are
// (a data source reading one of a database's tables).
const ownNode = (node: any, kind: ResourceKind, id: string) => {
  const ref = resourceOfNode(node);
  return ref?.kind === kind && ref.id === id && !(node.data?.tableName || node.data?.recordId);
};

const nodesUsing = (schema: any, kind: ResourceKind, id: string, skipOwn = false): any[] =>
  (Array.isArray(schema?.nodes) ? schema.nodes : []).filter((node: any) =>
    !(skipOwn && ownNode(node, kind, id))
    && FIELDS[kind].some(field => node?.data?.[field] === id));

const labels = (nodes: any[]) => [...new Set(nodes.map(n => n?.data?.label || n?.type).filter(Boolean))].join(', ');

/** The resource of that kind in the project, if it has it. */
export function findResource(project: any, kind: ResourceKind, id: string): any | null {
  const list = {
    db: project.dbConnections, api: project.connections, storage: project.storageConnections,
    service: project.integrationConnections, export: project.exports, pipeline: project.pipelines,
  }[kind] ?? [];
  return list.find((r: any) => String(r.id) === id) ?? null;
}

// A storage connection's files: a built-in one's older files were stamped with the provider's
// id, or with nothing (see routes/storage's connFilter).
const filesOf = (projectId: string, conn: any) => conn?.source === 'builtin'
  ? { projectId, $or: [{ storageConnectionId: conn.id }, { storageConnectionId: conn.integrationId }, { storageConnectionId: { $exists: false } }] }
  : { projectId, storageConnectionId: conn.id };

export async function dependentsOf(project: any, kind: ResourceKind, id: string): Promise<Dependent[]> {
  const projectId = String(project._id ?? project.id);
  const found: Dependent[] = [];

  const inWorkflow = nodesUsing(project.workflow?.nodeSchema, kind, id, true);
  if (inWorkflow.length) found.push({ type: 'workflow', name: labels(inWorkflow), count: inWorkflow.length });

  for (const exp of project.exports ?? []) {
    if (kind === 'export' && String(exp.id) === id) continue;
    const nodes = nodesUsing(exp.nodeSchema, kind, id);
    if (nodes.length) found.push({ type: 'export', id: String(exp.id), name: exp.name ?? String(exp.id), count: nodes.length });
  }

  const db = nosqlDb();
  if (!db) return found;

  const pipelines: any[] = await db.collection('pipelines').find({ projectId }).toArray();
  for (const pipeline of pipelines) {
    if (kind === 'pipeline' && pipeline.id === id) continue;
    const nodes = nodesUsing(pipeline.nodeSchema, kind, id);
    if (nodes.length) found.push({ type: 'pipeline', id: pipeline.id, name: pipeline.name ?? pipeline.id, count: nodes.length });
  }

  if (kind === 'storage') {
    const conn = findResource(project, 'storage', id);
    if (conn) {
      const files = await db.collection('storage_files').countDocuments(filesOf(projectId, conn));
      if (files) found.push({ type: 'files', name: 'Files', count: files });
      const folders = await db.collection('storage_folders').countDocuments(filesOf(projectId, conn));
      if (folders) found.push({ type: 'folders', name: 'Folders', count: folders });
    }
  }
  if (kind === 'export') {
    const deliverables = await db.collection('deliverables').countDocuments({ projectId, exportId: id });
    if (deliverables) found.push({ type: 'deliverables', name: 'Deliverables', count: deliverables });
    const shots = await db.collection('production_shots').countDocuments({ projectId, exportId: id });
    if (shots) found.push({ type: 'shots', name: 'Shots', count: shots });
  }
  return found;
}

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getModel } from '../models/manager';
import { nosqlDb } from '../utils/nosqlDb';
import { NodeSchema, StreamByConfig } from '../types';
import { deleteConnection } from './connection';
import { deleteExport } from './export';
import { deleteDeliverablesOf } from './deliverables';
import { exportSummaries, sanitizeConnections } from '../utils/sanitize';

// The workflow defines the project: each of its resources (a database, an API, a storage, a
// service, an export, a pipeline) is a node of it, that node bound to it by the resource's id
// in its data. Adding a resource from its section adds its node; removing it removes the node;
// and saving the workflow does the same the other way: a node removed removes its resource,
// a node set to an integration the project doesn't have connects it.

export type ResourceKind = 'db' | 'api' | 'storage' | 'service' | 'export' | 'pipeline';

type Row = 'input' | 'export' | 'pipeline';
interface NodeKind { type: string; field: string; list: string; row: Row; subtitle: (resource: any) => string }

export const NODE_OF: Record<ResourceKind, NodeKind> = {
  db: { type: 'dataSourceNode', field: 'connectionId', list: 'dbConnections', row: 'input', subtitle: r => r.dbType },
  api: { type: 'connectionNode', field: 'connectionId', list: 'connections', row: 'input', subtitle: r => r.method ?? 'GET' },
  storage: { type: 'ingestNode', field: 'storageConnectionId', list: 'storageConnections', row: 'input', subtitle: r => r.type },
  service: { type: 'integrationConnectionNode', field: 'integrationConnectionId', list: 'integrationConnections', row: 'input', subtitle: r => r.provider },
  export: { type: 'exportNode', field: 'exportId', list: 'exports', row: 'export', subtitle: r => r.method || 'GET' },
  pipeline: { type: 'pipelineRefNode', field: 'pipelineId', list: 'pipelines', row: 'pipeline', subtitle: () => 'Pipeline' },
};
const KINDS = Object.keys(NODE_OF) as ResourceKind[];
const KIND_OF_TYPE = new Map(KINDS.map(kind => [NODE_OF[kind].type, kind]));

// A node set to an integration the project doesn't have yet: connected when the workflow is saved.
export const CONNECT_PREFIX = '__connect__:';
const pendingOf = (value: unknown) => (typeof value === 'string' && value.startsWith(CONNECT_PREFIX) ? value.slice(CONNECT_PREFIX.length) : null);

const ORCHESTRATOR = 'streamby';
const EDGE_STYLE = { stroke: '#38b6ff', strokeWidth: 1.5 };

const emptySchema = (): NodeSchema => ({ nodes: [], edges: [] });
const schemaOf = (workflow: any): NodeSchema => ({
  nodes: Array.isArray(workflow?.nodeSchema?.nodes) ? workflow.nodeSchema.nodes : [],
  edges: Array.isArray(workflow?.nodeSchema?.edges) ? workflow.nodeSchema.edges : [],
});

/** The resource a node is bound to, if it's one of a resource's nodes and bound already. */
export function resourceOfNode(node: any): { kind: ResourceKind; id: string } | null {
  const kind = KIND_OF_TYPE.get(node?.type);
  const id = kind ? node?.data?.[NODE_OF[kind].field] : null;
  return kind && typeof id === 'string' && id && !pendingOf(id) ? { kind, id } : null;
}

/** The resources the workflow's nodes are bound to, by kind. */
export function referencedIn(schema: NodeSchema): Record<ResourceKind, Set<string>> {
  const refs = Object.fromEntries(KINDS.map(kind => [kind, new Set<string>()])) as Record<ResourceKind, Set<string>>;
  for (const node of schema.nodes) {
    const ref = resourceOfNode(node);
    if (ref) refs[ref.kind].add(ref.id);
  }
  return refs;
}

// A node of a consumer of a connection rather than the connection itself: a data source reading
// one table of a database, which a workflow may have beside the database's own node.
const consumes = (node: any) => node?.type === 'dataSourceNode' && !!(node.data?.tableName || node.data?.recordId);

// Where a new resource's node goes, as the canvas lays them out around the orchestrator: the
// inputs above it, the exports below, the pipelines on its left.
function placeFor(schema: NodeSchema, row: Row) {
  const orchestrator = schema.nodes.find(n => n.id === ORCHESTRATOR)?.position ?? { x: 350, y: 20 };
  const near = (a: number, b: number) => Math.abs(a - b) < 60;
  if (row === 'pipeline') {
    const x = orchestrator.x - 350;
    const ys = schema.nodes.filter(n => n.position && near(n.position.x, x)).map(n => n.position.y);
    return { x, y: ys.length ? Math.max(...ys) + 220 : orchestrator.y };
  }
  const y = row === 'input' ? orchestrator.y - 180 : orchestrator.y + 200;
  const xs = schema.nodes.filter(n => n.position && near(n.position.y, y)).map(n => n.position.x);
  return { x: xs.length ? Math.max(...xs) + 220 : orchestrator.x, y };
}

const orchestratorNode = () => ({ id: ORCHESTRATOR, type: 'orchestratorNode', position: { x: 350, y: 20 }, data: { label: 'StreamBy', subtitle: 'Orchestrator' } });

/** The schema with the resource's node, if it has none yet (as the canvas wires one). */
export function withResourceNode(schema: NodeSchema, kind: ResourceKind, resource: any): NodeSchema {
  const id = String(resource.id);
  if (referencedIn(schema)[kind].has(id)) return schema;
  const def = NODE_OF[kind];
  const base = schema.nodes.some(n => n.id === ORCHESTRATOR) ? schema : { ...schema, nodes: [orchestratorNode(), ...schema.nodes] };
  const nodeId = `${kind}-${id}-${crypto.randomUUID().slice(0, 8)}`;
  const node = { id: nodeId, type: def.type, position: placeFor(base, def.row), data: { label: resource.name ?? id, subtitle: def.subtitle(resource), [def.field]: id } };
  const edge = def.row === 'input'
    ? { id: `e-${nodeId}`, source: nodeId, sourceHandle: 'out-stream', target: ORCHESTRATOR, targetHandle: 'in-top', animated: false, style: EDGE_STYLE }
    : def.row === 'export'
      ? { id: `e-${nodeId}`, source: ORCHESTRATOR, sourceHandle: 'out-bottom', target: nodeId, targetHandle: 'in-orchestrator-bottom', animated: true, style: EDGE_STYLE }
      : { id: `e-${nodeId}`, source: ORCHESTRATOR, sourceHandle: 'out-pipeline', target: nodeId, targetHandle: 'in-orchestrator', animated: true, style: EDGE_STYLE };
  return { nodes: [...base.nodes, node], edges: [...base.edges, edge] };
}

/** The schema without the resource's nodes, nor their edges. */
export function withoutResourceNodes(schema: NodeSchema, kind: ResourceKind, id: string): NodeSchema {
  const gone = new Set(schema.nodes.filter(n => { const ref = resourceOfNode(n); return ref?.kind === kind && ref.id === id; }).map(n => n.id));
  return { nodes: schema.nodes.filter(n => !gone.has(n.id)), edges: schema.edges.filter(e => !gone.has(e.source) && !gone.has(e.target)) };
}

/** One node per resource: a second node bound to the same one merges into the first (its edges go to it). */
export function oneNodePerResource(schema: NodeSchema): NodeSchema {
  const first = new Map<string, string>();
  const merged = new Map<string, string>();
  const nodes = schema.nodes.filter(node => {
    const ref = resourceOfNode(node);
    if (!ref || consumes(node)) return true;
    const key = `${ref.kind}:${ref.id}`;
    const kept = first.get(key);
    if (!kept) { first.set(key, node.id); return true; }
    merged.set(node.id, kept);
    return false;
  });
  const seen = new Set<string>();
  const edges = schema.edges
    .map(e => ({ ...e, source: merged.get(e.source) ?? e.source, target: merged.get(e.target) ?? e.target }))
    .filter(e => {
      const key = `${e.source}|${e.sourceHandle ?? ''}|${e.target}|${e.targetHandle ?? ''}`;
      if (e.source === e.target || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { nodes, edges };
}

const LEGACY_PREFIX: [string, ResourceKind][] = [['db-', 'db'], ['api-', 'api'], ['storage-', 'storage'], ['svc-', 'service'], ['export-', 'export'], ['pipeline-', 'pipeline']];

/**
 * A workflow made before it defined the project, brought to it once: the nodes once drawn from
 * the project's lists bound by the id in their data (an API's had it only in its node id), the
 * orchestrator there, a node for each resource it has without one, and one node per resource.
 */
export function migrateSchema(project: any, schema: NodeSchema): NodeSchema {
  let nodes = schema.nodes.map(node => {
    const legacy = LEGACY_PREFIX.find(([prefix, kind]) => typeof node?.id === 'string' && node.id.startsWith(prefix) && NODE_OF[kind].type === node.type);
    if (!legacy) return node;
    const def = NODE_OF[legacy[1]];
    return node.data?.[def.field] ? node : { ...node, data: { ...node.data, [def.field]: node.id.slice(legacy[0].length) } };
  });
  if (!nodes.some(n => n.id === ORCHESTRATOR)) nodes = [orchestratorNode(), ...nodes];
  let migrated: NodeSchema = { nodes, edges: schema.edges };
  for (const kind of KINDS) {
    for (const resource of (project[NODE_OF[kind].list] ?? []) as any[]) migrated = withResourceNode(migrated, kind, resource);
  }
  return oneNodePerResource(migrated);
}

// ── Reading and writing a project's workflow ──

/** Saves the project's workflow (its single one, made if it has none) with the changes given. */
export async function writeWorkflow(project: any, changes: Record<string, unknown>): Promise<any> {
  const Project = getModel('projects');
  const projectId = String(project._id ?? project.id);
  const now = new Date();
  const base = project.workflow ?? { id: crypto.randomUUID(), name: 'Workflow', description: '', status: 'draft', projectId, nodeSchema: null, createdAt: now };
  const updated = { ...base, ...changes, id: base.id, projectId, updatedAt: now };
  if (project.dbType === 'sql') {
    await getModel('projects', 'sql').update({ _id: projectId }, { workflow: updated } as any);
  } else {
    await Project.update({ _id: new ObjectId(projectId) }, { $set: { workflow: updated } } as any);
  }
  return updated;
}

/** The project's workflow as it's answered: brought once to define the project (see migrateSchema). */
export async function readWorkflow(project: any): Promise<any> {
  if (project.workflow?.resourceNodesAt) return project.workflow;
  const nodeSchema = migrateSchema(project, schemaOf(project.workflow));
  return writeWorkflow(project, { nodeSchema, resourceNodesAt: new Date() });
}

// A change to the workflow saved, made on it as it is now (read again: another one may have
// been saved since the project was read).
async function changeSchema(projectId: string, change: (schema: NodeSchema) => NodeSchema) {
  const project = await getModel('projects').findOne({ _id: projectId });
  if (!project) return;
  const current = project.workflow?.resourceNodesAt ? schemaOf(project.workflow) : migrateSchema(project, schemaOf(project.workflow));
  await writeWorkflow(project, { nodeSchema: change(current), resourceNodesAt: project.workflow?.resourceNodesAt ?? new Date() });
}

/** A resource added from its section (or by an agent): its node, in the workflow. */
export const addToWorkflow = (projectId: string, kind: ResourceKind, resource: any) =>
  changeSchema(projectId, schema => withResourceNode(schema, kind, resource));

/** A resource removed from its section: its nodes, gone from the workflow. */
export const removeFromWorkflow = (projectId: string, kind: ResourceKind, id: string) =>
  changeSchema(projectId, schema => withoutResourceNodes(schema, kind, id));

// ── Removing a resource ──

/** Rewrites ProjectInfo.pipelines from the pipelines collection, sorted by order. */
export async function syncPipelineRefs(projectId: string): Promise<void> {
  const db = nosqlDb();
  if (!db) return;
  const all = await db.collection('pipelines').find({ projectId }).project({ _id: 0, id: 1, name: 1, order: 1 }).sort({ order: 1, createdAt: 1 }).toArray();
  await getModel('projects').update({ _id: projectId }, { pipelines: all.map((p: any) => ({ id: p.id, name: p.name, order: p.order })) } as any);
}

/**
 * Removes a resource from the project, only it (its node is the caller's: the workflow saved
 * without it, or removeFromWorkflow). A built-in disconnected keeps its id, to come back as it was.
 */
export async function removeResourceOf(project: any, kind: ResourceKind, id: string, config: StreamByConfig): Promise<void> {
  const Project = getModel('projects');
  const projectId = String(project._id ?? project.id);
  if (kind === 'db' || kind === 'storage' || kind === 'service') {
    const list = NODE_OF[kind].list;
    const conn = (project[list] ?? []).find((c: any) => c.id === id);
    if (!conn) return;
    await Project.update({ _id: projectId }, { $pull: { [list]: { id } } });
    if (conn.source === 'builtin' && conn.integrationId && kind !== 'service') {
      await Project.update({ _id: projectId }, { $pull: { disconnectedBuiltins: { integrationId: conn.integrationId } } });
      await Project.update({ _id: projectId }, { $push: { disconnectedBuiltins: { kind, integrationId: conn.integrationId, connectionId: conn.id } } });
    }
  } else if (kind === 'api') {
    if ((project.connections ?? []).some((c: any) => c.id === id)) await deleteConnection(config, projectId, id);
  } else if (kind === 'export') {
    if ((project.exports ?? []).some((e: any) => String(e.id) === id)) {
      await deleteExport(config, projectId, id, project.dbType);
      await deleteDeliverablesOf(projectId, { exportId: id });
    }
  } else {
    await nosqlDb()?.collection('pipelines').deleteOne({ id, projectId });
    await syncPipelineRefs(projectId);
  }
}

/** The project's resource lists as they're answered after a change. */
export async function listsOf(projectId: string) {
  const project: any = await getModel('projects').findOne({ _id: projectId });
  return {
    dbConnections: sanitizeConnections(project?.dbConnections),
    storageConnections: sanitizeConnections(project?.storageConnections),
    integrationConnections: sanitizeConnections(project?.integrationConnections),
    connections: sanitizeConnections(project?.connections),
    exports: exportSummaries(project?.exports),
    pipelines: project?.pipelines ?? [],
  };
}

export { emptySchema, pendingOf, schemaOf };

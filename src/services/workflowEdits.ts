import crypto from 'crypto';
import { NodeSchema } from '../types';
import { NODE_OF, pendingOf, ResourceKind } from './workflowResources';
import { APPLIES_TO } from './deliverableGates';

// Editing a workflow node by node (what an agent does, see the MCP server's edit_workflow):
// adding, changing, moving, connecting, disconnecting and removing nodes, with the canvas's
// rules. The changes are made on the workflow as it was read and saved as the canvas saves it
// (routes/workflow): a resource whose node is removed is removed with the same rules.

export const ORCHESTRATOR_NODE = 'orchestratorNode';

// What can be added to a workflow, and how it's named when no label is given.
export const WORKFLOW_NODE_TYPES: Record<string, { label: string; subtitle: string }> = {
  dataSourceNode: { label: 'Database', subtitle: 'DB collection' },
  connectionNode: { label: 'API', subtitle: 'External API' },
  ingestNode: { label: 'Storage', subtitle: 'Asset ingest' },
  integrationConnectionNode: { label: 'Service', subtitle: 'Integration' },
  pipelineRefNode: { label: 'Pipeline', subtitle: 'Pipeline' },
  exportNode: { label: 'Export', subtitle: 'GET' },
  creditsSheetNode: { label: 'Credits sheet', subtitle: 'Assets credits table' },
  reviewGateNode: { label: 'Review Gate', subtitle: 'Require approvals' },
  annotationNode: { label: 'Annotations', subtitle: 'Frame annotations' },
  exportFormatNode: { label: 'Export Format', subtitle: 'Codec / container' },
  deliverableNode: { label: 'Deliverable', subtitle: 'Package artifact' },
};

// The connections the workflow's canvas allows: from a node of one of `from` (by its handle
// `out`) to one of `to` (by its handle `in`). The handles are the canvas's.
const CONNECTIONS: { from: string[]; out: string; to: string[]; in: string }[] = [
  { from: [ORCHESTRATOR_NODE], out: 'out-pipeline', to: ['pipelineRefNode'], in: 'in-orchestrator' },
  { from: [ORCHESTRATOR_NODE], out: 'out-bottom', to: ['exportNode'], in: 'in-orchestrator-bottom' },
  { from: ['dataSourceNode', 'connectionNode', 'ingestNode', 'integrationConnectionNode'], out: 'out-stream', to: [ORCHESTRATOR_NODE], in: 'in-top' },
  // A credits sheet is fed the assets of Ingest nodes; it and a Review Gate hold back what's
  // after them (see deliverableGates).
  { from: ['ingestNode'], out: 'out-stream', to: ['creditsSheetNode'], in: 'in-assets' },
  { from: ['creditsSheetNode'], out: 'out-status', to: ['reviewGateNode'], in: 'in-process' },
  { from: ['creditsSheetNode'], out: 'out-status', to: ['deliverableNode'], in: 'in-filter' },
  { from: ['reviewGateNode'], out: 'out-review', to: ['deliverableNode'], in: 'in-filter' },
  { from: ['reviewGateNode'], out: 'out-review', to: ['annotationNode'], in: 'in-review' },
  { from: ['annotationNode', 'exportFormatNode', 'deliverableNode'], out: 'out-filter', to: ['exportFormatNode', 'deliverableNode'], in: 'in-filter' },
];

/** The handles a node of `source` connects to one of `target` by, or null if they don't connect. */
export function connectionOf(source: string, target: string): { sourceHandle: string; targetHandle: string } | null {
  const rule = CONNECTIONS.find(c => c.from.includes(source) && c.to.includes(target));
  return rule ? { sourceHandle: rule.out, targetHandle: rule.in } : null;
}

type Position = { x: number; y: number };
export type WorkflowEdit =
  | { op: 'add'; type: string; id?: string; label?: string; data?: Record<string, unknown>; position?: Position }
  | { op: 'update'; id: string; data: Record<string, unknown> }
  | { op: 'move'; id: string; position: Position }
  | { op: 'connect'; source: string; target: string }
  | { op: 'disconnect'; source: string; target: string }
  | { op: 'remove'; id: string };

export class WorkflowEditError extends Error {}

/** What a node's data may hold that ties it to something of the project: checked before saving. */
export interface BoundChecks {
  // Whether a credits sheet document of the project has this id.
  creditsSheet: (documentId: string) => Promise<boolean>;
  // Whether a review session of the project has this id.
  review: (reviewId: string) => Promise<boolean>;
  // The project, for its resources (connections, exports, pipelines).
  project: any;
}

const isPosition = (p: any): p is Position => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const isData = (d: any): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d);
// Its type, and the orchestrator's place, can't change by editing its data.
const FIXED = new Set(['type']);

/** Checks that what a node's data ties it to is the project's, as the canvas only offers those. */
async function checkBound(type: string, data: Record<string, unknown>, checks: BoundChecks, label: string): Promise<void> {
  if (type === 'creditsSheetNode') {
    if (typeof data.documentId !== 'string' || !data.documentId) {
      throw new WorkflowEditError(`${label}: a Credits sheet node is its sheet's place: give its documentId (create_document with kind 'credits')`);
    }
    if (!(await checks.creditsSheet(data.documentId))) throw new WorkflowEditError(`${label}: ${data.documentId} isn't a credits sheet of the project`);
  }
  if (type === 'reviewGateNode' && data.reviewId !== undefined && data.reviewId !== null && data.reviewId !== '') {
    if (typeof data.reviewId !== 'string' || !(await checks.review(data.reviewId))) throw new WorkflowEditError(`${label}: ${String(data.reviewId)} isn't a review session of the project`);
  }
  if (type === 'deliverableNode') {
    if (data.appliesTo !== undefined && !(APPLIES_TO as readonly string[]).includes(data.appliesTo as string)) {
      throw new WorkflowEditError(`${label}: appliesTo is one of ${APPLIES_TO.join(', ')}`);
    }
    if (data.exportId !== undefined && data.exportId !== null && data.exportId !== ''
      && !(checks.project.exports ?? []).some((e: any) => String(e.id) === data.exportId)) {
      throw new WorkflowEditError(`${label}: ${String(data.exportId)} isn't an export of the project`);
    }
  }
  // A resource's node: one of the project's resources (or one to connect when it's saved).
  const kind = (Object.keys(NODE_OF) as ResourceKind[]).find(k => NODE_OF[k].type === type);
  if (kind) {
    const { field, list } = NODE_OF[kind];
    const value = data[field];
    if (typeof value === 'string' && value && !pendingOf(value)
      && !(checks.project[list] ?? []).some((r: any) => String(r.id ?? r._id) === value)) {
      throw new WorkflowEditError(`${label}: ${value} isn't one of the project's ${list}`);
    }
  }
}

/**
 * A workflow with the edits made, in their order (an edit can refer to a node added by one
 * before it, by the id given to it). Throws a WorkflowEditError saying which edit can't be made.
 */
export async function applyWorkflowEdits(schema: NodeSchema, edits: WorkflowEdit[], checks: BoundChecks): Promise<NodeSchema> {
  let nodes: any[] = schema.nodes.map(n => ({ ...n }));
  let edges: any[] = schema.edges.map(e => ({ ...e }));
  const nodeOf = (id: unknown, at: string) => {
    const node = nodes.find(n => n.id === id);
    if (!node) throw new WorkflowEditError(`${at}: no node ${String(id)} in the workflow`);
    return node;
  };

  for (const [i, edit] of edits.entries()) {
    const at = `Edit ${i + 1} (${(edit as any)?.op ?? '?'})`;
    switch ((edit as any)?.op) {
      case 'add': {
        const e = edit as Extract<WorkflowEdit, { op: 'add' }>;
        const named = WORKFLOW_NODE_TYPES[e.type];
        if (!named) throw new WorkflowEditError(`${at}: a workflow's nodes are ${Object.keys(WORKFLOW_NODE_TYPES).join(', ')}`);
        if (e.data !== undefined && !isData(e.data)) throw new WorkflowEditError(`${at}: data is an object`);
        if (e.position !== undefined && !isPosition(e.position)) throw new WorkflowEditError(`${at}: position is { x, y }`);
        const id = e.id ?? `${e.type}-${crypto.randomUUID()}`;
        if (typeof id !== 'string' || !id || nodes.some(n => n.id === id)) throw new WorkflowEditError(`${at}: the workflow has a node ${String(id)} already`);
        const data = { label: e.label ?? named.label, subtitle: named.subtitle, ...(e.data ?? {}) };
        await checkBound(e.type, data, checks, at);
        // Below the rest, unless placed.
        const lowest = nodes.reduce((y, n) => Math.max(y, Number(n.position?.y) || 0), 0);
        nodes.push({ id, type: e.type, position: e.position ?? { x: 0, y: lowest + 160 }, data });
        break;
      }
      case 'update': {
        const e = edit as Extract<WorkflowEdit, { op: 'update' }>;
        const node = nodeOf(e.id, at);
        if (!isData(e.data)) throw new WorkflowEditError(`${at}: data is an object`);
        if (node.type === ORCHESTRATOR_NODE) throw new WorkflowEditError(`${at}: StreamBy's orchestrator doesn't change`);
        const changed = Object.fromEntries(Object.entries(e.data).filter(([k]) => !FIXED.has(k)));
        const data = { ...(node.data ?? {}), ...changed };
        await checkBound(node.type, data, checks, at);
        nodes = nodes.map(n => (n.id === node.id ? { ...n, data } : n));
        break;
      }
      case 'move': {
        const e = edit as Extract<WorkflowEdit, { op: 'move' }>;
        const node = nodeOf(e.id, at);
        if (!isPosition(e.position)) throw new WorkflowEditError(`${at}: position is { x, y }`);
        nodes = nodes.map(n => (n.id === node.id ? { ...n, position: { x: e.position.x, y: e.position.y } } : n));
        break;
      }
      case 'connect': {
        const e = edit as Extract<WorkflowEdit, { op: 'connect' }>;
        const source = nodeOf(e.source, at);
        const target = nodeOf(e.target, at);
        if (source.id === target.id) throw new WorkflowEditError(`${at}: a node doesn't connect to itself`);
        const handles = connectionOf(source.type, target.type);
        if (!handles) throw new WorkflowEditError(`${at}: a ${source.type} doesn't connect to a ${target.type}`);
        if (edges.some(edge => edge.source === source.id && edge.target === target.id)) {
          throw new WorkflowEditError(`${at}: ${source.id} is connected to ${target.id} already`);
        }
        edges.push({ id: `e-${source.id}-${target.id}`, source: source.id, target: target.id, ...handles });
        break;
      }
      case 'disconnect': {
        const e = edit as Extract<WorkflowEdit, { op: 'disconnect' }>;
        const before = edges.length;
        edges = edges.filter(edge => !(edge.source === e.source && edge.target === e.target));
        if (edges.length === before) throw new WorkflowEditError(`${at}: ${String(e.source)} isn't connected to ${String(e.target)}`);
        break;
      }
      case 'remove': {
        const e = edit as Extract<WorkflowEdit, { op: 'remove' }>;
        const node = nodeOf(e.id, at);
        if (node.type === ORCHESTRATOR_NODE) throw new WorkflowEditError(`${at}: StreamBy's orchestrator is part of every workflow: it can't be removed`);
        nodes = nodes.filter(n => n.id !== node.id);
        edges = edges.filter(edge => edge.source !== node.id && edge.target !== node.id);
        break;
      }
      default:
        throw new WorkflowEditError(`${at}: op is add, update, move, connect, disconnect or remove`);
    }
  }
  return { nodes, edges };
}

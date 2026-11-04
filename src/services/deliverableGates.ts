import { nosqlDb } from '../utils/nosqlDb';
import { activeMemberOf } from '../utils/auth';
import { emitToUser } from './wsHub';
import { documentStore } from './documents';
import { CREDITS_SHEET_NODE, readSheet } from './creditsSheets';
import { deliverablesCollection, Deliverable } from './deliverables';

// Gates: what a deliverable waits on before it's out. In the project's workflow, a Deliverable
// node stands for the deliverables it applies to (all of the project's, its shots', its exports'
// or one export's), and the gates it has before it (anything with an edge leading, step by step,
// to it) hold them back until each one passes:
//   - a Review Gate, when the review session it's linked to is approved;
//   - a Credits sheet, when its sheet is complete (an automatic rule: each asset fed to it has
//     its creator, link and license).
// A deliverable is ready when no Deliverable node applying to it has a gate that hasn't passed,
// and blocked otherwise: then its automatic workers don't run (they're held until it's ready),
// and its export can't be published. One no Deliverable node applies to, or whose nodes have
// no gates before them, is ready, as deliverables always were.

export const DELIVERABLE_NODE = 'deliverableNode';
export const REVIEW_GATE_NODE = 'reviewGateNode';

/** What a Deliverable node applies to: every deliverable, its shots', its exports' (or one export's). */
export const APPLIES_TO = ['all', 'shots', 'exports'] as const;
export type AppliesTo = typeof APPLIES_TO[number];

export type GateStatus = 'ready' | 'blocked';

/** A gate that hasn't passed: its node, and what it lacks. */
export interface Blocker {
  nodeId: string;
  type: string;
  label: string;
  reason: string;
}

export interface GateState {
  status: GateStatus;
  // Whether it has gates before it at all: one without them is ready, as always.
  gated: boolean;
  blockedBy: Blocker[];
}

const READY: GateState = { status: 'ready', gated: false, blockedBy: [] };

type Node = { id: string; type?: string; data?: Record<string, any> };
type Edge = { source: string; target: string };

const schemaOf = (project: any): { nodes: Node[]; edges: Edge[] } => ({
  nodes: Array.isArray(project?.workflow?.nodeSchema?.nodes) ? project.workflow.nodeSchema.nodes : [],
  edges: Array.isArray(project?.workflow?.nodeSchema?.edges) ? project.workflow.nodeSchema.edges : [],
});

const appliesToOf = (node: Node): AppliesTo =>
  (APPLIES_TO as readonly string[]).includes(node.data?.appliesTo) ? node.data!.appliesTo : 'all';

/** Whether a Deliverable node applies to a deliverable. */
export function appliesTo(node: Node, deliverable: Pick<Deliverable, 'shotId' | 'exportId'>): boolean {
  const to = appliesToOf(node);
  if (to === 'shots') return !!deliverable.shotId;
  if (to === 'exports') {
    const exportId = typeof node.data?.exportId === 'string' && node.data.exportId ? node.data.exportId : null;
    return !!deliverable.exportId && (!exportId || exportId === deliverable.exportId);
  }
  return true;
}

// ── Gates ──

type Evaluate = (project: any, node: Node) => Promise<string | null>;

// Each kind of gate: what it lacks to pass (null when it passes). Another kind (a worker's
// result, a QC check) is one more entry.
const GATES: Record<string, Evaluate> = {
  [REVIEW_GATE_NODE]: async (project, node) => {
    const reviewId = node.data?.reviewId;
    if (typeof reviewId !== 'string' || !reviewId) return 'No review session linked to it';
    const projectId = String(project._id ?? project.id);
    const review: any = await nosqlDb()?.collection('review_sessions').findOne({ id: reviewId, projectId });
    if (!review) return 'Its review session no longer exists';
    if (review.status === 'approved') return null;
    if (review.status === 'rejected') return 'Its review session was rejected';
    const approved = (review.approvals ?? []).filter((a: any) => a.decision === 'approve').length;
    return `Waiting for approvals: ${approved} of ${review.requiredApprovers ?? 1}`;
  },
  [CREDITS_SHEET_NODE]: async (project, node) => {
    const documentId = node.data?.documentId;
    const projectId = String(project._id ?? project.id);
    const document = typeof documentId === 'string' && documentId ? await documentStore().get(projectId, documentId) : null;
    if (!document || document.kind !== 'credits') return 'Its credits sheet no longer exists';
    const { rows, status } = await readSheet(project, document);
    if (status === 'complete') return null;
    if (!rows.length) return 'Its credits sheet has no assets';
    const lacking = rows.filter(r => r.missing.length).length;
    return `${lacking} of ${rows.length} assets lack credits`;
  },
};

export const isGate = (type: string | undefined) => !!type && type in GATES;

/** The gates a node has before it: every gate with edges leading, step by step, to it. */
export function gatesBefore(schema: { nodes: Node[]; edges: Edge[] }, nodeId: string): Node[] {
  const byId = new Map(schema.nodes.map(n => [n.id, n]));
  const into = new Map<string, string[]>();
  for (const e of schema.edges) into.set(e.target, [...(into.get(e.target) ?? []), e.source]);
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  const gates: Node[] = [];
  while (queue.length) {
    for (const source of into.get(queue.shift()!) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      queue.push(source);
      const node = byId.get(source);
      if (node && isGate(node.type)) gates.push(node);
    }
  }
  return gates;
}

/** The state of each of the workflow's Deliverable nodes, by node id: its gates, and which hold it. */
export async function deliverableNodeStates(project: any): Promise<Record<string, GateState & { appliesTo: AppliesTo; exportId: string | null }>> {
  const schema = schemaOf(project);
  const lacks = new Map<string, Promise<string | null>>();
  const evaluate = (gate: Node) => {
    if (!lacks.has(gate.id)) lacks.set(gate.id, GATES[gate.type!](project, gate).catch(err => `Couldn't be checked: ${err?.message ?? err}`));
    return lacks.get(gate.id)!;
  };
  const states: Record<string, GateState & { appliesTo: AppliesTo; exportId: string | null }> = {};
  for (const node of schema.nodes.filter(n => n.type === DELIVERABLE_NODE)) {
    const gates = gatesBefore(schema, node.id);
    const blockedBy: Blocker[] = [];
    for (const gate of gates) {
      const reason = await evaluate(gate);
      if (reason) blockedBy.push({ nodeId: gate.id, type: gate.type!, label: String(gate.data?.label ?? gate.type), reason });
    }
    states[node.id] = {
      status: blockedBy.length ? 'blocked' : 'ready', gated: gates.length > 0, blockedBy,
      appliesTo: appliesToOf(node), exportId: typeof node.data?.exportId === 'string' && node.data.exportId ? node.data.exportId : null,
    };
  }
  return states;
}

/** Each deliverable's state, by the Deliverable nodes that apply to it (in the order given). */
export async function deliverableStates(project: any, deliverables: Pick<Deliverable, 'id' | 'shotId' | 'exportId'>[]): Promise<GateState[]> {
  if (!deliverables.length) return [];
  const nodes = schemaOf(project).nodes.filter(n => n.type === DELIVERABLE_NODE);
  if (!nodes.length) return deliverables.map(() => READY);
  const states = await deliverableNodeStates(project);
  return deliverables.map(deliverable => {
    const applying = nodes.filter(n => appliesTo(n, deliverable)).map(n => states[n.id]);
    const blockedBy = applying.flatMap(s => s.blockedBy).filter((b, i, all) => all.findIndex(x => x.nodeId === b.nodeId) === i);
    return { status: blockedBy.length ? 'blocked' : 'ready', gated: applying.some(s => s.gated), blockedBy };
  });
}

/** A deliverable with its state. */
export const withState = <T extends Pick<Deliverable, 'id' | 'shotId' | 'exportId'>>(deliverable: T, state: GateState) => ({ ...deliverable, ...state });

/** What holds an export's deliverables back: none if each one is ready. */
export async function blockersOfExport(project: any, exportId: string): Promise<Blocker[]> {
  const col = deliverablesCollection();
  if (!col) return [];
  const projectId = String(project._id ?? project.id);
  const deliverables = await col.find({ projectId, exportId }).toArray() as any[];
  const states = await deliverableStates(project, deliverables);
  return states.flatMap(s => s.blockedBy).filter((b, i, all) => all.findIndex(x => x.nodeId === b.nodeId) === i);
}

// ── A gate changed ──

export interface Release {
  // Starts a deliverable's held automatic workers, as whoever changed the gate.
  run: (deliverable: Deliverable) => Promise<unknown>;
}

/**
 * Something a gate reads changed (a review decided, an asset's credits, a sheet, the workflow):
 * the project's members are told to read the deliverables' states again, and the deliverables
 * that were held and are ready now get their automatic workers, if `release` is given.
 */
export async function gatesChanged(project: any, release?: Release): Promise<void> {
  const projectId = String(project?._id ?? project?.id ?? '');
  if (!projectId) return;
  for (const member of project.members ?? []) {
    if (activeMemberOf(project, member.userId)) emitToUser(member.userId, { type: 'deliverableGatesEvent', data: { projectId } });
  }
  const col = deliverablesCollection();
  if (!release || !col) return;
  const held = (await col.find({ projectId, heldJobs: true }).toArray()).map(({ _id, ...d }: any) => d as Deliverable);
  if (!held.length) return;
  const states = await deliverableStates(project, held);
  for (const [i, deliverable] of held.entries()) {
    if (states[i].status !== 'ready') continue;
    // Only once: of two changes at the same time, the one that takes it starts them.
    const taken = await col.updateOne({ projectId, id: deliverable.id, heldJobs: true }, { $unset: { heldJobs: '' } });
    if (!taken.modifiedCount) continue;
    await release.run(deliverable).catch(err => console.error(`❌ StreamBy deliverables: couldn't start the workers held for ${deliverable.id}:`, err?.message ?? err));
  }
}

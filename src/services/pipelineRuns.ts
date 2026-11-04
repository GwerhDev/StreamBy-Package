import crypto from 'crypto';
import { Auth, JobRecord, StorageAdapter, StreamByConfig } from '../types';
import { nosqlDb } from '../utils/nosqlDb';
import { activeMemberOf } from '../utils/auth';
import { emitToUser } from './wsHub';
import { onJobChange } from './jobQueue';
import { documentStore } from './documents';
import { CREDITS_SHEET_NODE } from './creditsSheets';
import { createDeliverable } from './deliverables';
import { DELIVERABLE_NODE, REVIEW_GATE_NODE, gateLacks, gatesChanged } from './deliverableGates';
import { roleMay } from './projectPermissions';
import { WorkerError } from './workers';
import { enqueueWorkerJob } from './workerJobs';
import { getModel } from '../models/manager';

// A pipeline's runs: each card (a production shot) linked to a pipeline goes through it, step by
// step, its own run. A step is a node of the pipeline's schema, and it's one of:
//   - done by people: a Meeting (its document published), Tasks (the card's tasks linked to it
//     done, or the card itself, when none is), a Review Gate (the review session of the card's
//     asset, or the one it's linked to, approved), a Credits sheet (complete);
//   - done by a worker: a node set to one (data.worker and data.kind), which processes the run's
//     asset and gives it its result;
//   - a Deliverable: the run's asset, marked as a deliverable of the card (or of its export);
//   - anything else (a Shot, a Master...): nothing to wait on, it passes.
// A step starts when the steps with edges into it are done, and it's done when its source says
// so: a card's or a task's status (never its column's name), a review's decision, a document
// published, a job ended. Each of those events moves the runs it may concern on (advanceRuns).
//
// A run starts by hand, or by the pipeline's triggers: a card linked to it, a card done, or one
// of its card's assets marked as a deliverable. Its workers run as whoever started it, while
// their role lets them run jobs. A pipeline with no triggers (as every one before them) never
// starts a run by itself: it works as it always did.

export const MEETING_NODE = 'meetingNode';
export const TASKS_NODE = 'tasksNode';

export const PIPELINE_TRIGGERS = ['card_linked', 'card_done', 'deliverable_marked'] as const;
export type PipelineTrigger = typeof PIPELINE_TRIGGERS[number] | 'manual';

export type StepKind = 'meeting' | 'tasks' | 'review' | 'credits' | 'worker' | 'deliverable' | 'pass';
export type StepStatus = 'waiting' | 'active' | 'running' | 'done' | 'failed';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StepState {
  status: StepStatus;
  // What it waits on (waiting, active), or what went wrong (failed).
  reason: string | null;
  jobId?: string | null;
  deliverableId?: string | null;
  doneAt?: Date | null;
}

export interface PipelineRun {
  id: string;
  projectId: string;
  pipelineId: string;
  shotId: string;
  trigger: PipelineTrigger;
  status: RunStatus;
  steps: Record<string, StepState>;
  // The asset it carries: a worker's result, once one ended (the card's asset until then).
  assetId: string | null;
  versionId: string | null;
  // Its workers' jobs, to find it by when one ends.
  jobIds: string[];
  // Each change is made over the revision it read: of two at once, one wins and the other reads again.
  revision: number;
  requester: { userId: string; username: string; role: Auth['role'] };
  callbackBase: string;
  createdAt: Date;
  updatedAt: Date;
}

type Node = { id: string; type?: string; data?: Record<string, any> };
type Edge = { source: string; target: string };
type RouterConfig = StreamByConfig & { adapter?: StorageAdapter };

const runsCollection = () => nosqlDb()?.collection('pipeline_runs') ?? null;
const db = () => nosqlDb();

const schemaOf = (pipeline: any): { nodes: Node[]; edges: Edge[] } => ({
  nodes: Array.isArray(pipeline?.nodeSchema?.nodes) ? pipeline.nodeSchema.nodes : [],
  edges: Array.isArray(pipeline?.nodeSchema?.edges) ? pipeline.nodeSchema.edges : [],
});

const strip = ({ _id, ...run }: any): PipelineRun => run;

/** What a node is as a step. */
export function kindOf(node: Node): StepKind {
  if (node.type === MEETING_NODE) return 'meeting';
  if (node.type === TASKS_NODE) return 'tasks';
  if (node.type === REVIEW_GATE_NODE) return 'review';
  if (node.type === CREDITS_SHEET_NODE) return 'credits';
  if (node.type === DELIVERABLE_NODE) return 'deliverable';
  const worker = node.data?.worker;
  if (worker && typeof worker.id === 'string' && worker.id && typeof worker.source === 'string' && typeof node.data?.kind === 'string' && node.data.kind) return 'worker';
  return 'pass';
}

/** Who completes a step: its people and teams, or its worker; nobody for one that passes. */
export function completedBy(node: Node): { userIds: string[]; teamIds: string[] } | { worker: string; kind: string } | null {
  const kind = kindOf(node);
  if (kind === 'worker') return { worker: String(node.data!.worker.name ?? node.data!.worker.id), kind: node.data!.kind };
  if (kind === 'pass' || kind === 'deliverable') return null;
  const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : []);
  return { userIds: ids(node.data?.assignedTo), teamIds: ids(node.data?.teamIds) };
}

/** A pipeline's triggers, as saved (none for one saved before it had them). */
export const triggersOf = (pipeline: any): PipelineTrigger[] =>
  (Array.isArray(pipeline?.triggers) ? pipeline.triggers : []).filter((t: unknown) => (PIPELINE_TRIGGERS as readonly unknown[]).includes(t));

/** The triggers given for a pipeline, checked. */
export function checkTriggers(value: unknown): PipelineTrigger[] | { error: string } {
  if (!Array.isArray(value) || !value.every(t => (PIPELINE_TRIGGERS as readonly unknown[]).includes(t))) {
    return { error: `triggers must be a list of: ${PIPELINE_TRIGGERS.join(', ')} (a run can always be started by hand)` };
  }
  return [...new Set(value as PipelineTrigger[])];
}

// ── Where it is ──

interface Context {
  project: any;
  projectId: string;
  pipeline: any;
  card: any;
  assetId: string | null;
  versionId: string | null;
}

type Evaluation = { done: true; versionId?: string } | { done: false; reason: string };

const waitingFor = (reason: string): Evaluation => ({ done: false, reason });

// What a step done by people (or a gate) lacks, for this run: nothing when it's done.
async function evaluate(node: Node, ctx: Context): Promise<Evaluation> {
  switch (kindOf(node)) {
    case 'meeting': {
      const documentId = node.data?.documentId;
      if (typeof documentId !== 'string' || !documentId) return waitingFor('No document linked to it');
      const document = await documentStore().get(ctx.projectId, documentId);
      if (!document) return waitingFor('Its document no longer exists');
      return document.publishedVersion === null || document.publishedVersion === undefined ? waitingFor('Waiting for its document to be published') : { done: true };
    }
    case 'tasks': {
      const tasks = await db()!.collection('production_tasks').find({ projectId: ctx.projectId, shotId: ctx.card.id, stepId: node.id }).toArray();
      if (tasks.length) {
        const open = tasks.filter((t: any) => t.status !== 'done').length;
        return open ? waitingFor(`${open} of ${tasks.length} tasks open`) : { done: true };
      }
      return ctx.card.status === 'done' ? { done: true } : waitingFor('Waiting for its card to be done');
    }
    case 'review': {
      const reviewId = node.data?.reviewId;
      const sessions = db()!.collection('review_sessions');
      const session: any = typeof reviewId === 'string' && reviewId
        ? await sessions.findOne({ id: reviewId, projectId: ctx.projectId })
        : ctx.assetId ? (await sessions.find({ projectId: ctx.projectId, assetId: ctx.assetId }).sort({ createdAt: -1 }).limit(1).toArray())[0] : null;
      if (!session) return waitingFor(reviewId ? 'Its review session no longer exists' : ctx.assetId ? 'No review session of its asset yet' : 'Its card has no asset');
      if (session.status === 'approved') return { done: true, ...(session.assetId === ctx.assetId && session.assetVersionId ? { versionId: session.assetVersionId } : {}) };
      if (session.status === 'rejected') return waitingFor('Its review session was rejected');
      const approved = (session.approvals ?? []).filter((a: any) => a.decision === 'approve').length;
      return waitingFor(`Waiting for approvals: ${approved} of ${session.requiredApprovers ?? 1}`);
    }
    case 'credits': {
      const lacks = await gateLacks(ctx.project, node as any);
      return lacks ? waitingFor(lacks) : { done: true };
    }
    default:
      return { done: true };
  }
}

const sameState = (a: StepState | undefined, b: StepState) =>
  !!a && a.status === b.status && a.reason === b.reason && (a.jobId ?? null) === (b.jobId ?? null) && (a.deliverableId ?? null) === (b.deliverableId ?? null);

const labelOf = (node: Node | undefined) => String(node?.data?.label ?? node?.type ?? 'a step');

// ── Moving on ──

let runConfig: RouterConfig | null = null;

/** The configuration a run's workers are sent with (set when the routes are made). */
export function usePipelineRuns(config: RouterConfig): void {
  runConfig = config;
}

const emitRun = (project: any, run: PipelineRun) => {
  for (const member of project?.members ?? []) {
    if (activeMemberOf(project, member.userId)) {
      emitToUser(member.userId, { type: 'pipelineRunEvent', data: { projectId: run.projectId, pipelineId: run.pipelineId, shotId: run.shotId, runId: run.id } });
    }
  }
};

// Saves a change to a run over the revision it was read at: whether it was the one saved.
async function save(run: PipelineRun, change: Partial<PipelineRun>): Promise<boolean> {
  const taken = await runsCollection()!.updateOne(
    { id: run.id, revision: run.revision },
    { $set: { ...change, revision: run.revision + 1, updatedAt: new Date() } },
  );
  return taken.modifiedCount > 0;
}

const MAX_TRIES = 8;

/**
 * Moves a run on as far as it goes now: each step whose steps before it are done is done, if
 * its source says so; a worker's step sends its job, a Deliverable step marks the asset. What
 * the run is then (completed once every step is done).
 */
export async function advanceRun(project: any, runId: string): Promise<PipelineRun | null> {
  const col = runsCollection();
  if (!col) return null;
  const projectId = String(project._id ?? project.id);
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const found = await col.findOne({ id: runId, projectId });
    if (!found) return null;
    const run = strip(found);
    if (run.status !== 'running') return run;

    const pipeline = await db()!.collection('pipelines').findOne({ id: run.pipelineId, projectId });
    const card = await db()!.collection('production_shots').findOne({ id: run.shotId, projectId });
    if (!pipeline || !card) {
      if (await save(run, { status: 'cancelled' })) { emitRun(project, run); return { ...run, status: 'cancelled' }; }
      continue;
    }

    const { nodes, edges } = schemaOf(pipeline);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const into = new Map<string, string[]>();
    for (const e of edges) if (byId.has(e.source) && byId.has(e.target)) into.set(e.target, [...(into.get(e.target) ?? []), e.source]);

    const ctx: Context = { project, projectId, pipeline, card, assetId: run.assetId ?? card.assetId ?? null, versionId: run.versionId ?? null };
    // Only the steps the schema still has.
    const steps: Record<string, StepState> = Object.fromEntries(Object.entries(run.steps ?? {}).filter(([id]) => byId.has(id)));
    let changed = Object.keys(steps).length !== Object.keys(run.steps ?? {}).length;
    const toStart: Node[] = [];

    for (let moved = true; moved;) {
      moved = false;
      for (const node of nodes) {
        const before = steps[node.id];
        if (before && ['done', 'failed', 'running'].includes(before.status)) continue;
        const pending = (into.get(node.id) ?? []).filter(id => steps[id]?.status !== 'done');
        let next: StepState;
        if (pending.length) {
          next = { status: 'waiting', reason: `Waiting for: ${pending.map(id => labelOf(byId.get(id))).join(', ')}` };
        } else {
          const kind = kindOf(node);
          if ((kind === 'worker' || kind === 'deliverable') && !ctx.assetId) {
            next = { status: 'active', reason: 'Its card has no asset' };
          } else if (kind === 'worker' || kind === 'deliverable') {
            next = { status: 'running', reason: null };
            toStart.push(node);
          } else {
            const result = await evaluate(node, ctx);
            if (result.done) {
              next = { status: 'done', reason: null, doneAt: new Date() };
              if (result.versionId) ctx.versionId = result.versionId;
            } else {
              next = { status: 'active', reason: result.reason };
            }
          }
        }
        if (!sameState(before, next)) { steps[node.id] = next; changed = true; moved = true; }
      }
    }

    const states = nodes.map(n => steps[n.id]?.status);
    const status: RunStatus = states.includes('failed') ? 'failed' : states.every(s => s === 'done') ? 'completed' : 'running';
    if (!changed && status === run.status) return run;
    const change = { steps, status, versionId: ctx.versionId };
    if (!(await save(run, change))) continue;
    const saved: PipelineRun = { ...run, ...change, revision: run.revision + 1 };
    emitRun(project, saved);

    // What this change started, now that it's the one saved: only it does.
    if (!toStart.length) return saved;
    for (const node of toStart) await startStep(project, saved, node, ctx);
    return strip(await col.findOne({ id: runId, projectId }));
  }
  return strip(await col.findOne({ id: runId, projectId }));
}

// Changes one step of a run (and what the run carries), over whatever it is now.
async function patchStep(project: any, runId: string, nodeId: string, state: StepState, extra: Partial<PipelineRun> = {}): Promise<PipelineRun | null> {
  const col = runsCollection()!;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const found = await col.findOne({ id: runId });
    if (!found) return null;
    const run = strip(found);
    const steps = { ...run.steps, [nodeId]: state };
    const status: RunStatus = state.status === 'failed' ? 'failed' : run.status === 'failed' && state.status === 'done' ? 'running' : run.status;
    const jobIds = state.jobId && !run.jobIds.includes(state.jobId) ? [...run.jobIds, state.jobId] : run.jobIds;
    if (await save(run, { steps, status, jobIds, ...extra })) {
      const saved = { ...run, steps, status, jobIds, ...extra, revision: run.revision + 1 };
      emitRun(project, saved);
      return saved;
    }
  }
  return null;
}

async function startStep(project: any, run: PipelineRun, node: Node, ctx: Context): Promise<void> {
  const kind = kindOf(node);
  const fail = (reason: string) => patchStep(project, run.id, node.id, { status: 'failed', reason });
  if (kind === 'deliverable') {
    const exportId = typeof node.data?.exportId === 'string' && node.data.exportId ? node.data.exportId : null;
    try {
      const deliverable = await createDeliverable({
        projectId: run.projectId, assetId: ctx.assetId!, versionId: ctx.versionId,
        shotId: exportId ? null : run.shotId, exportId, note: null, createdBy: run.requester.userId,
      });
      await patchStep(project, run.id, node.id, { status: 'done', reason: null, deliverableId: deliverable.id, doneAt: new Date() });
      await gatesChanged(project).catch(() => {});
      // Marked, it's done: what comes after it may go on.
      await advanceRun(project, run.id);
    } catch (err: any) {
      await fail(`It couldn't be marked: ${err?.message ?? err}`);
    }
    return;
  }

  // A worker's step: its job, as whoever started the run, while their role lets them run jobs.
  if (!(await roleMay(project, run.requester.userId, 'jobs:run'))) {
    await fail(`${run.requester.username || 'Whoever started it'} can't run jobs in this project`);
    return;
  }
  if (!runConfig) { await fail('Workers aren\'t set up'); return; }
  try {
    const job = await enqueueWorkerJob(project, {
      assetId: ctx.assetId, versionId: ctx.versionId, worker: node.data!.worker, kind: node.data!.kind,
      profile: node.data!.profile, resultMode: node.data!.resultMode,
    }, run.requester as Auth, runConfig, run.callbackBase);
    await patchStep(project, run.id, node.id, { status: 'running', reason: null, jobId: job.jobId });
  } catch (err: any) {
    await fail(err instanceof WorkerError ? err.message : `Its job couldn't be sent: ${err?.message ?? err}`);
  }
}

/** A worker's job ended: its run's step is done (the run carries its result) or failed. */
export async function jobEnded(job: JobRecord): Promise<void> {
  if (job.status !== 'completed' && job.status !== 'failed') return;
  const col = runsCollection();
  if (!col) return;
  const found = await col.findOne({ projectId: job.projectId, jobIds: job.jobId });
  if (!found) return;
  const run = strip(found);
  const nodeId = Object.entries(run.steps).find(([, s]) => s.jobId === job.jobId)?.[0];
  if (!nodeId || run.status === 'cancelled' || run.status === 'completed') return;
  const project = await getModel('projects').findOne({ _id: job.projectId });
  if (!project) return;
  if (job.status === 'failed') {
    await patchStep(project, run.id, nodeId, { status: 'failed', reason: job.error ?? 'Its job failed', jobId: job.jobId });
    return;
  }
  const result = job.result;
  await patchStep(project, run.id, nodeId, { status: 'done', reason: null, jobId: job.jobId, doneAt: new Date() },
    result?.assetId ? { assetId: result.assetId, versionId: result.versionId || null } : {});
  await advanceRun(project, run.id);
}

onJobChange(job => { jobEnded(job).catch(err => console.error('❌ StreamBy pipelines: a job ended:', err?.message ?? err)); });

// ── Starting one ──

export type StartResult = { run: PipelineRun } | { error: string; status: number; run?: PipelineRun };

/** A card's run of a pipeline, started (by hand or by a trigger) as `auth`. */
export async function startRun(project: any, pipelineId: string, shotId: string, trigger: PipelineTrigger, auth: Auth, callbackBase: string): Promise<StartResult> {
  const col = runsCollection();
  if (!col) return { error: 'Database not available', status: 500 };
  const projectId = String(project._id ?? project.id);
  const pipeline = await db()!.collection('pipelines').findOne({ id: pipelineId, projectId });
  if (!pipeline) return { error: 'Pipeline not found', status: 404 };
  const card = await db()!.collection('production_shots').findOne({ id: shotId, projectId });
  if (!card) return { error: 'Shot not found', status: 404 };
  if (card.pipelineId !== pipelineId) return { error: "The shot isn't in this pipeline: link it first (its pipelineId)", status: 400 };
  const running = await col.findOne({ projectId, pipelineId, shotId, status: 'running' });
  if (running) return { error: 'The shot already has a run of this pipeline going', status: 409, run: strip(running) };

  const now = new Date();
  const run: PipelineRun = {
    id: crypto.randomUUID(), projectId, pipelineId, shotId, trigger, status: 'running', steps: {},
    assetId: null, versionId: null, jobIds: [], revision: 0,
    requester: { userId: auth.userId, username: auth.username, role: auth.role }, callbackBase,
    createdAt: now, updatedAt: now,
  };
  await col.insertOne({ ...run });
  return { run: (await advanceRun(project, run.id)) ?? run };
}

/** Moves on the running runs something changed may concern: a card's, a pipeline's, or the project's. */
export async function advanceRuns(project: any, of: { shotId?: string; pipelineId?: string } = {}): Promise<void> {
  const col = runsCollection();
  if (!col || !project) return;
  const projectId = String(project._id ?? project.id);
  const running = await col.find({ projectId, status: 'running', ...(of.shotId ? { shotId: of.shotId } : {}), ...(of.pipelineId ? { pipelineId: of.pipelineId } : {}) }).toArray();
  for (const run of running) {
    await advanceRun(project, run.id).catch(err => console.error(`❌ StreamBy pipelines: run ${run.id} couldn't move on:`, err?.message ?? err));
  }
}

// Whether a request may start runs by a trigger: workers run as it, so only if it may run jobs.
async function mayRun(project: any, auth: Auth | undefined, tokenMayRun: boolean): Promise<boolean> {
  return !!auth?.userId && tokenMayRun && await roleMay(project, auth.userId, 'jobs:run');
}

/**
 * A card changed (or was made): its pipeline's triggers start its run (linked to it, or done),
 * a run of a pipeline it's no longer in ends, and its runs move on.
 */
export async function cardChanged(project: any, before: any | null, after: any, auth: Auth | undefined, tokenMayRun: boolean, callbackBase: string): Promise<void> {
  const col = runsCollection();
  if (!col || !after) return;
  const projectId = String(project._id ?? project.id);
  if (before?.pipelineId && before.pipelineId !== after.pipelineId) {
    for (const run of await col.find({ projectId, shotId: after.id, pipelineId: before.pipelineId, status: 'running' }).toArray()) {
      if (await save(strip(run), { status: 'cancelled' })) emitRun(project, strip(run));
    }
  }
  if (after.pipelineId) {
    const pipeline = await db()!.collection('pipelines').findOne({ id: after.pipelineId, projectId });
    const triggers = triggersOf(pipeline);
    const linked = after.pipelineId !== before?.pipelineId && triggers.includes('card_linked');
    const done = after.status === 'done' && before?.status !== 'done' && triggers.includes('card_done');
    if ((linked || done) && await mayRun(project, auth, tokenMayRun)) {
      await startRun(project, after.pipelineId, after.id, linked ? 'card_linked' : 'card_done', auth!, callbackBase);
    }
  }
  await advanceRuns(project, { shotId: after.id });
}

/** A deliverable was marked for a card: its pipeline starts its run, if it's set to. */
export async function deliverableMarked(project: any, deliverable: { shotId: string | null }, auth: Auth | undefined, tokenMayRun: boolean, callbackBase: string): Promise<void> {
  if (!deliverable.shotId) return;
  const projectId = String(project._id ?? project.id);
  const card = await db()?.collection('production_shots').findOne({ id: deliverable.shotId, projectId });
  if (!card?.pipelineId) return;
  const pipeline = await db()!.collection('pipelines').findOne({ id: card.pipelineId, projectId });
  if (triggersOf(pipeline).includes('deliverable_marked') && await mayRun(project, auth, tokenMayRun)) {
    await startRun(project, card.pipelineId, card.id, 'deliverable_marked', auth!, callbackBase);
  }
}

/** A pipeline, or a card, is gone: so are its runs. */
export async function deleteRunsOf(projectId: string, of: { pipelineId?: string; shotId?: string }): Promise<void> {
  const col = runsCollection();
  if (!col) return;
  if (of.pipelineId) await col.deleteMany({ projectId, pipelineId: of.pipelineId });
  if (of.shotId) await col.deleteMany({ projectId, shotId: of.shotId });
}

// ── As it's answered ──

export interface DescribedStep {
  nodeId: string;
  type: string;
  label: string;
  kind: StepKind;
  status: StepStatus;
  reason: string | null;
  jobId: string | null;
  deliverableId: string | null;
  completedBy: ReturnType<typeof completedBy>;
}

/** A run as it's shown: each step of its pipeline (in the schema's order), who completes it and what it waits on. */
export function describeRun(run: PipelineRun, pipeline: any, card: { id: string; name?: string; key?: string | null } | null) {
  const { nodes } = schemaOf(pipeline);
  const steps: DescribedStep[] = nodes.map(node => {
    const state = run.steps?.[node.id];
    return {
      nodeId: node.id, type: node.type ?? '', label: labelOf(node), kind: kindOf(node),
      status: state?.status ?? 'waiting', reason: state?.reason ?? null,
      jobId: state?.jobId ?? null, deliverableId: state?.deliverableId ?? null,
      completedBy: completedBy(node),
    };
  });
  const { jobIds: _jobs, revision: _revision, callbackBase: _callback, requester, ...shown } = run;
  return {
    ...shown,
    startedBy: requester.userId,
    card: card ? { id: card.id, name: card.name ?? '', key: card.key ?? null } : null,
    steps,
    // Where it is: the steps it's on now.
    current: steps.filter(s => s.status === 'active' || s.status === 'running').map(s => s.nodeId),
  };
}

/** A project's runs, of a pipeline or a card, newest first. */
export async function listRuns(projectId: string, of: { pipelineId?: string; shotId?: string }): Promise<PipelineRun[]> {
  const col = runsCollection();
  if (!col) return [];
  return (await col.find({ projectId, ...(of.pipelineId ? { pipelineId: of.pipelineId } : {}), ...(of.shotId ? { shotId: of.shotId } : {}) })
    .sort({ createdAt: -1 }).toArray()).map(strip);
}

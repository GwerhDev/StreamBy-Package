import crypto from 'crypto';
import { getModel } from '../models/manager';
import { Auth, StorageCategoryName, StreamByConfig } from '../types';
import { activeMemberOf } from '../utils/auth';
import { listTeams } from './teams';
import { DEFAULT_WORKER_TIMEOUT_SECONDS, STORAGE_CATEGORIES, WorkerError } from './workers';

// Worker runners: a machine (a user's, behind a router, or one in the cloud) that connects to
// StreamBy and asks for jobs, instead of being sent them (it has no public URL to be sent to).
//
// - Its owner registers it: a name, and its own token ("sbr_" and 32 random bytes), shown once;
//   only its hash is kept. The token only asks for jobs and hands them in: it acts as nobody.
// - One runner is one machine. On each poll it declares what it can do now (its kinds and the
//   asset categories it takes): what's offered in a project's list of workers is the last it
//   declared, and a job is handed to it only if it declares the job's kind (and its asset's
//   category) when it asks. A poll is its heartbeat: it's online if it polled in the last minute.
// - Its owner shares it with a project, or with a team of a project, they're an active member
//   of: it's in that project's workers (for the team's members only, and its owner) while they
//   still are. Not shared, it's in no project's.
// - A job goes to one runner, which may be offline: it waits for it, 24 hours at most.

export const RUNNER_TOKEN_PREFIX = 'sbr_';
const PREFIX_SHOWN = RUNNER_TOKEN_PREFIX.length + 8;
export const ONLINE_WITHIN_MS = 60_000;
export const RUNNER_WAIT_MS = 24 * 3600_000;
const MAX_KINDS = 50;

export interface WorkerRunnerRecord {
  id: string;
  // Its owner, and their username then.
  userId: string;
  ownerName: string | null;
  name: string;
  // The token's first characters, to tell it apart; sha256 of the whole token.
  prefix: string;
  hash: string;
  // What it declared last.
  kinds: string[];
  categories: StorageCategoryName[];
  timeoutSeconds: number | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface RunnerShare {
  id: string;
  runnerId: string;
  projectId: string;
  // Only this team's members (and the runner's owner) use it; null: the project's editors.
  teamId: string | null;
  // What it runs by itself on a deliverable of the project (chosen by the project's admins):
  // one of the kinds it declares, or null.
  autoKind?: string | null;
  createdAt: Date;
}

/** What its owner sees of a runner: never its hash. */
export interface WorkerRunnerInfo {
  id: string;
  name: string;
  prefix: string;
  kinds: string[];
  categories: StorageCategoryName[];
  online: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  shares: { id: string; projectId: string; projectName: string | null; teamId: string | null; teamName: string | null }[];
}

const runners = () => getModel('worker_runners');
const shares = () => getModel('worker_runner_shares');
const projects = () => getModel('projects');
const mainDbType = (config: StreamByConfig) => config.databases?.find(db => db.main)?.type ?? 'nosql';
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

// A list, as stored in SQL JSON: read back as a list or as its text.
const listOf = (value: unknown): string[] => {
  if (typeof value === 'string') {
    try { return listOf(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String) : [];
};

const recordOf = (row: any): WorkerRunnerRecord => ({
  ...row,
  kinds: listOf(row.kinds),
  categories: listOf(row.categories) as StorageCategoryName[],
  timeoutSeconds: row.timeoutSeconds ?? null,
  lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt) : null,
});

export const isOnline = (runner: Pick<WorkerRunnerRecord, 'lastSeenAt'>, now = Date.now()) =>
  !!runner.lastSeenAt && now - new Date(runner.lastSeenAt).getTime() <= ONLINE_WITHIN_MS;

export async function findRunner(runnerId: string): Promise<WorkerRunnerRecord | null> {
  const row = await runners().findOne({ id: runnerId });
  return row ? recordOf(row) : null;
}

// ── Its owner: registering, listing, revoking ──

/** A new runner: its token, shown only now, and what's kept of it. */
export async function registerRunner(auth: Auth, body: any, config: StreamByConfig): Promise<{ token: string; runner: WorkerRunnerInfo }> {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) throw new WorkerError('A runner needs a name (e.g. the machine it runs on)');
  if (name.length > 100) throw new WorkerError('name must be at most 100 characters');
  const token = RUNNER_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record: WorkerRunnerRecord = {
    id: crypto.randomUUID(), userId: auth.userId, ownerName: auth.username ?? null, name,
    prefix: token.slice(0, PREFIX_SHOWN), hash: hashOf(token),
    kinds: [], categories: [], timeoutSeconds: null, lastSeenAt: null, createdAt: new Date(),
  };
  await runners().create({ ...record, dbType: mainDbType(config) } as any);
  return { token, runner: { ...infoBase(record), shares: [] } };
}

const infoBase = (runner: WorkerRunnerRecord): Omit<WorkerRunnerInfo, 'shares'> => ({
  id: runner.id, name: runner.name, prefix: runner.prefix, kinds: runner.kinds, categories: runner.categories,
  online: isOnline(runner), lastSeenAt: runner.lastSeenAt, createdAt: runner.createdAt,
});

/** A user's own runners, with where they're shared. */
export async function listOwnRunners(userId: string): Promise<WorkerRunnerInfo[]> {
  const own = ((await runners().find({ userId })) as any[]).map(recordOf);
  const names = new Map<string, { name: string | null; teams: Map<string, string> }>();
  const projectOf = async (projectId: string) => {
    if (!names.has(projectId)) {
      const project = await projects().findOne({ _id: projectId });
      const teams = project ? ((await listTeams(project)) ?? []) : [];
      names.set(projectId, { name: project?.name ?? null, teams: new Map(teams.map(t => [t.id, t.name])) });
    }
    return names.get(projectId)!;
  };
  const infos: WorkerRunnerInfo[] = [];
  for (const runner of own) {
    const its = (await shares().find({ runnerId: runner.id })) as RunnerShare[];
    const shown: WorkerRunnerInfo['shares'] = [];
    for (const share of its) {
      const project = await projectOf(share.projectId);
      shown.push({
        id: share.id, projectId: share.projectId, projectName: project.name,
        teamId: share.teamId ?? null, teamName: share.teamId ? project.teams.get(share.teamId) ?? null : null,
      });
    }
    infos.push({ ...infoBase(runner), shares: shown });
  }
  return infos.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Revokes a user's own runner: its token stops working at once, and it's shared nowhere. Whether there was one. */
export async function revokeRunner(userId: string, runnerId: string): Promise<boolean> {
  const runner = await runners().findOne({ id: runnerId, userId });
  if (!runner) return false;
  for (const share of (await shares().find({ runnerId })) as RunnerShare[]) await shares().delete({ id: share.id });
  return (await runners().delete({ id: runnerId, userId })) > 0;
}

// ── Sharing ──

/**
 * Shares a user's runner with a project they're an active member of, or with one of its teams
 * (`teamId`). One share per project: sharing it there again changes with whom.
 */
export async function shareRunner(auth: Auth, runnerId: string, body: any, config: StreamByConfig): Promise<RunnerShare> {
  const runner = await runners().findOne({ id: runnerId, userId: auth.userId });
  if (!runner) throw new WorkerError('Runner not found', 404);
  const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
  const project = projectId ? await projects().findOne({ _id: projectId }) : null;
  if (!project) throw new WorkerError('Project not found', 404);
  if (!activeMemberOf(project, auth.userId)) throw new WorkerError('Share it only with a project you are an active member of', 403);
  const teamId = typeof body?.teamId === 'string' && body.teamId ? body.teamId : null;
  if (teamId && !((await listTeams(project)) ?? []).some(t => t.id === teamId)) throw new WorkerError("That team isn't the project's", 400);

  const existing = (await shares().find({ runnerId, projectId })) as RunnerShare[];
  if (existing[0]) {
    await shares().update({ id: existing[0].id }, { teamId });
    return { ...existing[0], teamId };
  }
  const share: RunnerShare = { id: crypto.randomUUID(), runnerId, projectId, teamId, createdAt: new Date() };
  await shares().create({ ...share, dbType: mainDbType(config) } as any);
  return share;
}

/** Stops sharing a user's runner there. Whether it was. */
export async function unshareRunner(userId: string, runnerId: string, shareId: string): Promise<boolean> {
  if (!(await runners().findOne({ id: runnerId, userId }))) return false;
  return (await shares().delete({ id: shareId, runnerId })) > 0;
}

/** A deleted project's shares. */
export async function deleteProjectRunnerShares(projectId: string): Promise<void> {
  for (const share of (await shares().find({ projectId })) as RunnerShare[]) await shares().delete({ id: share.id });
}

// ── In a project ──

/**
 * Whether `auth` may send a runner jobs in a project, by its share there: its owner is still an
 * active member, and the share is the project's, or a team's `auth` is in (or `auth` owns it).
 */
async function usable(project: any, runner: WorkerRunnerRecord, share: RunnerShare, auth: Auth, teamsOf: () => Promise<{ id: string; memberIds: string[] }[]>): Promise<string | null> {
  if (!activeMemberOf(project, runner.userId)) return "This runner's owner is no longer in the project";
  if (share.teamId && auth.userId !== runner.userId) {
    const team = (await teamsOf()).find(t => t.id === share.teamId);
    if (!team?.memberIds.includes(auth.userId)) return 'This runner is shared with a team you are not in';
  }
  return null;
}

const memoTeams = (project: any) => {
  let cached: Promise<{ id: string; memberIds: string[] }[]> | null = null;
  return () => (cached ??= listTeams(project).then(t => t ?? []));
};

/** What a runner runs by itself in a project: its share's choice, while it still declares it. */
const autoKindOf = (runner: WorkerRunnerRecord, share: RunnerShare): string | null =>
  share.autoKind && runner.kinds.includes(share.autoKind) ? share.autoKind : null;

/** The runners shared with a project that `auth` may send jobs to, with what each runs by itself. */
export async function projectRunners(project: any, auth: Auth): Promise<{ runner: WorkerRunnerRecord; autoKind: string | null }[]> {
  const projectId = String(project._id ?? project.id);
  const teamsOf = memoTeams(project);
  const found: { runner: WorkerRunnerRecord; autoKind: string | null }[] = [];
  for (const share of (await shares().find({ projectId })) as RunnerShare[]) {
    const runner = await findRunner(share.runnerId);
    if (runner && !(await usable(project, runner, share, auth, teamsOf))) found.push({ runner, autoKind: autoKindOf(runner, share) });
  }
  return found;
}

/**
 * Chooses what a runner shared with a project runs by itself on its deliverables (a project
 * admin's to choose, the route checks): one of the kinds it declares, or null for nothing.
 */
export async function setRunnerAutoKind(project: any, runnerId: string, value: unknown): Promise<string | null> {
  const projectId = String(project._id ?? project.id);
  const runner = await findRunner(runnerId);
  const [share] = runner ? ((await shares().find({ runnerId, projectId })) as RunnerShare[]) : [];
  if (!runner || !share) throw new WorkerError('Worker not found', 404);
  const autoKind = value === null || value === '' ? null : value;
  if (autoKind !== null && (typeof autoKind !== 'string' || !runner.kinds.includes(autoKind))) {
    throw new WorkerError(`autoKind must be one of the kinds ${runner.name} declares (${runner.kinds.join(', ') || 'none yet'}), or null`);
  }
  await shares().update({ id: share.id }, { autoKind });
  return autoKind;
}

/** A runner of a project that `auth` may send jobs to, or why not. */
export async function resolveRunner(project: any, runnerId: string, auth: Auth): Promise<WorkerRunnerRecord> {
  const projectId = String(project._id ?? project.id);
  const runner = await findRunner(runnerId);
  const [share] = runner ? ((await shares().find({ runnerId, projectId })) as RunnerShare[]) : [];
  if (!runner || !share) throw new WorkerError('Worker not found', 404);
  const why = await usable(project, runner, share, auth, memoTeams(project));
  if (why) throw new WorkerError(why, 403);
  return runner;
}

export const runnerTimeoutSeconds = (runner: WorkerRunnerRecord) => runner.timeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS;

// ── The runner itself ──

/** The runner a token is, if it's one. */
export async function runnerByToken(authorization: string | undefined): Promise<WorkerRunnerRecord | null> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token?.startsWith(RUNNER_TOKEN_PREFIX)) return null;
  const row = await runners().findOne({ hash: hashOf(token) });
  return row ? recordOf(row) : null;
}

export interface Declaration { kinds: string[]; categories: StorageCategoryName[]; timeoutSeconds: number | null }

/** What a runner says it can do now, checked. */
export function checkDeclaration(body: any): Declaration {
  const kinds = Array.isArray(body?.kinds) ? body.kinds : null;
  if (!kinds || kinds.length > MAX_KINDS || !kinds.every((k: unknown) => typeof k === 'string' && k.trim() && k.length <= 100)) {
    throw new WorkerError('kinds must list what the runner can do now (e.g. gltf-optimize)');
  }
  const categories = Array.isArray(body?.categories) ? body.categories : null;
  if (!categories || !categories.every((c: unknown) => (STORAGE_CATEGORIES as unknown[]).includes(c))) {
    throw new WorkerError(`categories must list asset categories it takes: ${STORAGE_CATEGORIES.join(', ')}`);
  }
  const timeoutSeconds = body?.timeoutSeconds === undefined || body.timeoutSeconds === null ? null : Number(body.timeoutSeconds);
  if (timeoutSeconds !== null && !(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 60 && timeoutSeconds <= 7 * 86400)) {
    throw new WorkerError('timeoutSeconds must be a whole number of seconds, from 60 to a week');
  }
  return {
    kinds: [...new Set((kinds as string[]).map(k => k.trim()))],
    categories: [...new Set(categories as StorageCategoryName[])],
    timeoutSeconds,
  };
}

/** Keeps what a runner declared, and that it was seen now. */
export async function keepDeclaration(runner: WorkerRunnerRecord, declared: Declaration): Promise<WorkerRunnerRecord> {
  const lastSeenAt = new Date();
  await runners().update({ id: runner.id }, { kinds: declared.kinds, categories: declared.categories, timeoutSeconds: declared.timeoutSeconds, lastSeenAt });
  return { ...runner, ...declared, lastSeenAt };
}

/** A runner at work (calling back about its job): seen now. */
export async function runnerSeen(runnerId: string): Promise<void> {
  await runners().update({ id: runnerId }, { lastSeenAt: new Date() }).catch(() => {});
}

// ── Waiting for a job ──

// The polls waiting on this instance, by runner: a job queued here for one wakes them. (One
// queued on another instance is found when the poll looks again, every few seconds.)
const waiting = new Map<string, Set<() => void>>();

/** Wakes the polls waiting here for a runner's job. */
export function wakeRunner(runnerId: string): void {
  for (const wake of waiting.get(runnerId) ?? []) wake();
}

/** Waits until a runner's job may be there (woken), `ms` passed, or `signal` aborted. */
export function waitForRunnerJob(runnerId: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const set = waiting.get(runnerId) ?? new Set();
    waiting.set(runnerId, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) waiting.delete(runnerId);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    signal.addEventListener('abort', done);
  });
}

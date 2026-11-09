import crypto from 'crypto';
import { getModel } from '../models/manager';
import { Auth, StorageCategoryName, StreamByConfig } from '../types';
import { activeMemberOf } from '../utils/auth';
import { listTeams } from './teams';
import { DEFAULT_WORKER_TIMEOUT_SECONDS, STORAGE_CATEGORIES, WorkerError } from './workers';

// Worker agents: a machine (a user's, behind a router, or one in the cloud) that connects to
// StreamBy and asks for jobs, instead of being sent them (it has no public URL to be sent to).
//
// - Its owner registers it: a name, and its own token ("sba_" and 32 random bytes), shown once;
//   only its hash is kept. The token only asks for jobs and hands them in: it acts as nobody.
// - One agent is one machine. On each poll it declares what it can do now (its kinds and the
//   asset categories it takes): what's offered in a project's list of workers is the last it
//   declared, and a job is handed to it only if it declares the job's kind (and its asset's
//   category) when it asks. A poll is its heartbeat: it's online if it polled in the last minute.
// - Its owner shares it with a project, or with a team of a project, they're an active member
//   of: it's in that project's workers (for the team's members only, and its owner) while they
//   still are. Not shared, it's in no project's.
// - A job goes to one agent, which may be offline: it waits for it, 24 hours at most.

export const AGENT_TOKEN_PREFIX = 'sba_';
const PREFIX_SHOWN = AGENT_TOKEN_PREFIX.length + 8;
export const ONLINE_WITHIN_MS = 60_000;
export const AGENT_WAIT_MS = 24 * 3600_000;
const MAX_KINDS = 50;

export interface WorkerAgentRecord {
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

export interface AgentShare {
  id: string;
  agentId: string;
  projectId: string;
  // Only this team's members (and the agent's owner) use it; null: the project's editors.
  teamId: string | null;
  createdAt: Date;
}

/** What its owner sees of an agent: never its hash. */
export interface WorkerAgentInfo {
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

const agents = () => getModel('worker_agents');
const shares = () => getModel('worker_agent_shares');
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

const recordOf = (row: any): WorkerAgentRecord => ({
  ...row,
  kinds: listOf(row.kinds),
  categories: listOf(row.categories) as StorageCategoryName[],
  timeoutSeconds: row.timeoutSeconds ?? null,
  lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt) : null,
});

export const isOnline = (agent: Pick<WorkerAgentRecord, 'lastSeenAt'>, now = Date.now()) =>
  !!agent.lastSeenAt && now - new Date(agent.lastSeenAt).getTime() <= ONLINE_WITHIN_MS;

export async function findAgent(agentId: string): Promise<WorkerAgentRecord | null> {
  const row = await agents().findOne({ id: agentId });
  return row ? recordOf(row) : null;
}

// ── Its owner: registering, listing, revoking ──

/** A new agent: its token, shown only now, and what's kept of it. */
export async function registerAgent(auth: Auth, body: any, config: StreamByConfig): Promise<{ token: string; agent: WorkerAgentInfo }> {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) throw new WorkerError('An agent needs a name (e.g. the machine it runs on)');
  if (name.length > 100) throw new WorkerError('name must be at most 100 characters');
  const token = AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record: WorkerAgentRecord = {
    id: crypto.randomUUID(), userId: auth.userId, ownerName: auth.username ?? null, name,
    prefix: token.slice(0, PREFIX_SHOWN), hash: hashOf(token),
    kinds: [], categories: [], timeoutSeconds: null, lastSeenAt: null, createdAt: new Date(),
  };
  await agents().create({ ...record, dbType: mainDbType(config) } as any);
  return { token, agent: { ...infoBase(record), shares: [] } };
}

const infoBase = (agent: WorkerAgentRecord): Omit<WorkerAgentInfo, 'shares'> => ({
  id: agent.id, name: agent.name, prefix: agent.prefix, kinds: agent.kinds, categories: agent.categories,
  online: isOnline(agent), lastSeenAt: agent.lastSeenAt, createdAt: agent.createdAt,
});

/** A user's own agents, with where they're shared. */
export async function listOwnAgents(userId: string): Promise<WorkerAgentInfo[]> {
  const own = ((await agents().find({ userId })) as any[]).map(recordOf);
  const names = new Map<string, { name: string | null; teams: Map<string, string> }>();
  const projectOf = async (projectId: string) => {
    if (!names.has(projectId)) {
      const project = await projects().findOne({ _id: projectId });
      const teams = project ? ((await listTeams(project)) ?? []) : [];
      names.set(projectId, { name: project?.name ?? null, teams: new Map(teams.map(t => [t.id, t.name])) });
    }
    return names.get(projectId)!;
  };
  const infos: WorkerAgentInfo[] = [];
  for (const agent of own) {
    const its = (await shares().find({ agentId: agent.id })) as AgentShare[];
    const shown: WorkerAgentInfo['shares'] = [];
    for (const share of its) {
      const project = await projectOf(share.projectId);
      shown.push({
        id: share.id, projectId: share.projectId, projectName: project.name,
        teamId: share.teamId ?? null, teamName: share.teamId ? project.teams.get(share.teamId) ?? null : null,
      });
    }
    infos.push({ ...infoBase(agent), shares: shown });
  }
  return infos.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Revokes a user's own agent: its token stops working at once, and it's shared nowhere. Whether there was one. */
export async function revokeAgent(userId: string, agentId: string): Promise<boolean> {
  const agent = await agents().findOne({ id: agentId, userId });
  if (!agent) return false;
  for (const share of (await shares().find({ agentId })) as AgentShare[]) await shares().delete({ id: share.id });
  return (await agents().delete({ id: agentId, userId })) > 0;
}

// ── Sharing ──

/**
 * Shares a user's agent with a project they're an active member of, or with one of its teams
 * (`teamId`). One share per project: sharing it there again changes with whom.
 */
export async function shareAgent(auth: Auth, agentId: string, body: any, config: StreamByConfig): Promise<AgentShare> {
  const agent = await agents().findOne({ id: agentId, userId: auth.userId });
  if (!agent) throw new WorkerError('Agent not found', 404);
  const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
  const project = projectId ? await projects().findOne({ _id: projectId }) : null;
  if (!project) throw new WorkerError('Project not found', 404);
  if (!activeMemberOf(project, auth.userId)) throw new WorkerError('Share it only with a project you are an active member of', 403);
  const teamId = typeof body?.teamId === 'string' && body.teamId ? body.teamId : null;
  if (teamId && !((await listTeams(project)) ?? []).some(t => t.id === teamId)) throw new WorkerError("That team isn't the project's", 400);

  const existing = (await shares().find({ agentId, projectId })) as AgentShare[];
  if (existing[0]) {
    await shares().update({ id: existing[0].id }, { teamId });
    return { ...existing[0], teamId };
  }
  const share: AgentShare = { id: crypto.randomUUID(), agentId, projectId, teamId, createdAt: new Date() };
  await shares().create({ ...share, dbType: mainDbType(config) } as any);
  return share;
}

/** Stops sharing a user's agent there. Whether it was. */
export async function unshareAgent(userId: string, agentId: string, shareId: string): Promise<boolean> {
  if (!(await agents().findOne({ id: agentId, userId }))) return false;
  return (await shares().delete({ id: shareId, agentId })) > 0;
}

/** A deleted project's shares. */
export async function deleteProjectAgentShares(projectId: string): Promise<void> {
  for (const share of (await shares().find({ projectId })) as AgentShare[]) await shares().delete({ id: share.id });
}

// ── In a project ──

/**
 * Whether `auth` may send an agent jobs in a project, by its share there: its owner is still an
 * active member, and the share is the project's, or a team's `auth` is in (or `auth` owns it).
 */
async function usable(project: any, agent: WorkerAgentRecord, share: AgentShare, auth: Auth, teamsOf: () => Promise<{ id: string; memberIds: string[] }[]>): Promise<string | null> {
  if (!activeMemberOf(project, agent.userId)) return "This agent's owner is no longer in the project";
  if (share.teamId && auth.userId !== agent.userId) {
    const team = (await teamsOf()).find(t => t.id === share.teamId);
    if (!team?.memberIds.includes(auth.userId)) return 'This agent is shared with a team you are not in';
  }
  return null;
}

const memoTeams = (project: any) => {
  let cached: Promise<{ id: string; memberIds: string[] }[]> | null = null;
  return () => (cached ??= listTeams(project).then(t => t ?? []));
};

/** The agents shared with a project that `auth` may send jobs to. */
export async function projectAgents(project: any, auth: Auth): Promise<WorkerAgentRecord[]> {
  const projectId = String(project._id ?? project.id);
  const teamsOf = memoTeams(project);
  const found: WorkerAgentRecord[] = [];
  for (const share of (await shares().find({ projectId })) as AgentShare[]) {
    const agent = await findAgent(share.agentId);
    if (agent && !(await usable(project, agent, share, auth, teamsOf))) found.push(agent);
  }
  return found;
}

/** An agent of a project that `auth` may send jobs to, or why not. */
export async function resolveAgent(project: any, agentId: string, auth: Auth): Promise<WorkerAgentRecord> {
  const projectId = String(project._id ?? project.id);
  const agent = await findAgent(agentId);
  const [share] = agent ? ((await shares().find({ agentId, projectId })) as AgentShare[]) : [];
  if (!agent || !share) throw new WorkerError('Worker not found', 404);
  const why = await usable(project, agent, share, auth, memoTeams(project));
  if (why) throw new WorkerError(why, 403);
  return agent;
}

export const agentTimeoutSeconds = (agent: WorkerAgentRecord) => agent.timeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS;

// ── The agent itself ──

/** The agent a token is, if it's one. */
export async function agentByToken(authorization: string | undefined): Promise<WorkerAgentRecord | null> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token?.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const row = await agents().findOne({ hash: hashOf(token) });
  return row ? recordOf(row) : null;
}

export interface Declaration { kinds: string[]; categories: StorageCategoryName[]; timeoutSeconds: number | null }

/** What an agent says it can do now, checked. */
export function checkDeclaration(body: any): Declaration {
  const kinds = Array.isArray(body?.kinds) ? body.kinds : null;
  if (!kinds || kinds.length > MAX_KINDS || !kinds.every((k: unknown) => typeof k === 'string' && k.trim() && k.length <= 100)) {
    throw new WorkerError('kinds must list what the agent can do now (e.g. gltf-optimize)');
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

/** Keeps what an agent declared, and that it was seen now. */
export async function keepDeclaration(agent: WorkerAgentRecord, declared: Declaration): Promise<WorkerAgentRecord> {
  const lastSeenAt = new Date();
  await agents().update({ id: agent.id }, { kinds: declared.kinds, categories: declared.categories, timeoutSeconds: declared.timeoutSeconds, lastSeenAt });
  return { ...agent, ...declared, lastSeenAt };
}

/** An agent at work (calling back about its job): seen now. */
export async function agentSeen(agentId: string): Promise<void> {
  await agents().update({ id: agentId }, { lastSeenAt: new Date() }).catch(() => {});
}

// ── Waiting for a job ──

// The polls waiting on this instance, by agent: a job queued here for one wakes them. (One
// queued on another instance is found when the poll looks again, every few seconds.)
const waiting = new Map<string, Set<() => void>>();

/** Wakes the polls waiting here for an agent's job. */
export function wakeAgent(agentId: string): void {
  for (const wake of waiting.get(agentId) ?? []) wake();
}

/** Waits until an agent's job may be there (woken), `ms` passed, or `signal` aborted. */
export function waitForAgentJob(agentId: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const set = waiting.get(agentId) ?? new Set();
    waiting.set(agentId, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) waiting.delete(agentId);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    signal.addEventListener('abort', done);
  });
}

import crypto from 'crypto';
import { isIP } from 'net';
import { Auth, StorageCategoryName, StreamByConfig, WorkerConfig, WorkerRef } from '../types';
import { activeMemberOf } from '../utils/auth';
import { assertBuiltinAccess } from '../utils/builtinAccess';
import { decrypt, encrypt, isEncryptionKeySet } from '../utils/encryption';

// Processing workers: external services StreamBy sends jobs to (see workerJobs). A project
// can use the host's built-in ones (StreamByConfig.workers, gated by canUseBuiltin) and its
// own, connected from the project. A project's workers are kept in its
// `renderFarmConnections` list (render farms are workers too); each one's credential is
// encrypted, and it's used only while whoever connected it is still in the project.

export const STORAGE_CATEGORIES: StorageCategoryName[] = ['images', 'audios', 'videos', '3d-models'];
export const WORKER_PROVIDERS = ['streamby-worker', 'flamenco', 'deadline', 'rebusfarm', 'sheepit', 'custom'] as const;
export const DEFAULT_WORKER_TIMEOUT_SECONDS = 3600;

/** A project's worker, as stored. */
export interface WorkerConnection {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  // Its endpoint (named as render farms' were).
  apiUrl: string;
  encryptedCredential?: string;
  kinds?: string[];
  categories?: StorageCategoryName[];
  autoKind?: string | null;
  timeoutSeconds?: number;
  description?: string;
  createdBy?: string;
  createdAt: Date;
}

/** What a project's member sees of a worker: never its credential. */
export interface WorkerSummary {
  source: WorkerRef['source'];
  id: string;
  name: string;
  provider: string;
  kinds: string[];
  categories: StorageCategoryName[];
  autoKind: string | null;
  description: string | null;
  hasCredential: boolean;
  createdBy: string | null;
}

/** A worker ready to be sent a job. */
export interface ResolvedWorker {
  ref: WorkerRef;
  endpoint: string;
  credential: string | null;
  kinds: string[];
  categories: StorageCategoryName[];
  autoKind: string | null;
  timeoutSeconds: number;
}

export class WorkerError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export const projectWorkers = (project: any): WorkerConnection[] =>
  Array.isArray(project?.renderFarmConnections) ? project.renderFarmConnections : [];

const builtinSummary = (worker: WorkerConfig): WorkerSummary => ({
  source: 'builtin', id: worker.id, name: worker.name, provider: 'streamby-worker',
  kinds: worker.kinds ?? [], categories: worker.categories ?? [], autoKind: worker.autoKind ?? null,
  description: null, hasCredential: !!worker.credential, createdBy: null,
});

const projectSummary = (worker: WorkerConnection): WorkerSummary => ({
  source: 'project', id: worker.id, name: worker.name, provider: worker.provider,
  kinds: listOf(worker.kinds), categories: listOf(worker.categories) as StorageCategoryName[],
  autoKind: worker.autoKind ?? null, description: worker.description ?? null,
  hasCredential: !!worker.encryptedCredential, createdBy: worker.createdBy ?? null,
});

/** The workers a project's member can send jobs to: the project's own, and the host's they may use. */
export async function availableWorkers(project: any, auth: Auth, config: StreamByConfig): Promise<WorkerSummary[]> {
  const builtins: WorkerSummary[] = [];
  for (const worker of config.workers ?? []) {
    if (await assertBuiltinAccess(auth, worker.id, config, 'worker')) builtins.push(builtinSummary(worker));
  }
  return [...builtins, ...projectWorkers(project).map(projectSummary)];
}

/** A worker of the project, or of the host, ready to be sent a job as `auth`. */
export async function resolveWorker(project: any, ref: { source: string; id: string }, auth: Auth, config: StreamByConfig): Promise<ResolvedWorker> {
  if (ref.source === 'builtin') {
    const worker = (config.workers ?? []).find(w => w.id === ref.id);
    if (!worker) throw new WorkerError('Worker not found', 404);
    if (!(await assertBuiltinAccess(auth, worker.id, config, 'worker'))) throw new WorkerError('This worker is not available to you', 403);
    return {
      ref: { source: 'builtin', id: worker.id, name: worker.name },
      endpoint: worker.endpoint, credential: worker.credential ?? null,
      kinds: worker.kinds ?? [], categories: worker.categories ?? [], autoKind: worker.autoKind ?? null,
      timeoutSeconds: worker.timeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS,
    };
  }
  if (ref.source === 'project') {
    const worker = projectWorkers(project).find(w => w.id === ref.id);
    if (!worker) throw new WorkerError('Worker not found', 404);
    // Tied to whoever connected it: once they leave the project, its credential isn't used.
    if (worker.createdBy && !activeMemberOf(project, worker.createdBy)) {
      throw new WorkerError('Whoever connected this worker is no longer in the project: connect it again', 409);
    }
    return {
      ref: { source: 'project', id: worker.id, name: worker.name },
      endpoint: worker.apiUrl, credential: worker.encryptedCredential ? decrypt(worker.encryptedCredential) : null,
      kinds: listOf(worker.kinds), categories: listOf(worker.categories) as StorageCategoryName[],
      autoKind: worker.autoKind ?? null, timeoutSeconds: worker.timeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS,
    };
  }
  throw new WorkerError("A worker's source is 'builtin' or 'project'");
}

// A project's worker is reached from StreamBy's server: only over https, and never at a local
// or private address (unless the host allows it, for development).
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;
const isPrivateAddress = (host: string) => {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) {
    const [a, b] = bare.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(bare) === 6) return bare === '::1' || /^(fc|fd|fe80)/i.test(bare) || bare.startsWith('::ffff:');
  return PRIVATE_HOST.test(bare);
};

export function checkWorkerEndpoint(value: unknown, config: StreamByConfig): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new WorkerError('endpoint must be a URL'); }
  const local = config.workerOptions?.allowLocalEndpoints === true;
  if (url.username || url.password) throw new WorkerError("endpoint can't carry credentials: give them as credential");
  if (!local && url.protocol !== 'https:') throw new WorkerError('endpoint must use https');
  if (!local && isPrivateAddress(url.hostname)) throw new WorkerError("endpoint can't be a local or private address");
  if (!['https:', 'http:'].includes(url.protocol)) throw new WorkerError('endpoint must use https');
  return url.toString();
}

export interface WorkerInput {
  name?: unknown;
  provider?: unknown;
  endpoint?: unknown;
  credential?: unknown;
  kinds?: unknown;
  categories?: unknown;
  autoKind?: unknown;
  timeoutSeconds?: unknown;
  description?: unknown;
}

/** A project's new worker, checked and with its credential encrypted. */
export function newWorkerConnection(input: WorkerInput, projectId: string, userId: string, config: StreamByConfig): WorkerConnection {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new WorkerError('A worker needs a name');
  const provider = input.provider === undefined ? 'streamby-worker' : input.provider;
  if (!(WORKER_PROVIDERS as readonly unknown[]).includes(provider)) throw new WorkerError(`provider must be one of ${WORKER_PROVIDERS.join(', ')}`);
  const endpoint = checkWorkerEndpoint(input.endpoint, config);
  const kinds = listOf(input.kinds).map(k => k.trim()).filter(Boolean);
  if (!kinds.length || kinds.length !== listOf(input.kinds).length) throw new WorkerError('kinds must list what the worker does (e.g. gltf-optimize)');
  const categories = listOf(input.categories);
  if (!categories.length || !categories.every(c => (STORAGE_CATEGORIES as string[]).includes(c))) {
    throw new WorkerError(`categories must list asset categories it takes: ${STORAGE_CATEGORIES.join(', ')}`);
  }
  const autoKind = input.autoKind === undefined || input.autoKind === null || input.autoKind === '' ? null : input.autoKind;
  if (autoKind !== null && (typeof autoKind !== 'string' || !kinds.includes(autoKind))) throw new WorkerError('autoKind must be one of its kinds, or null');
  const timeoutSeconds = input.timeoutSeconds === undefined ? undefined : Number(input.timeoutSeconds);
  if (timeoutSeconds !== undefined && !(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 60 && timeoutSeconds <= 7 * 86400)) {
    throw new WorkerError('timeoutSeconds must be a whole number of seconds, from 60 to a week');
  }
  const credential = typeof input.credential === 'string' && input.credential ? input.credential : null;
  if (credential && !isEncryptionKeySet()) throw new WorkerError('Credentials cannot be stored: no encryption key is set', 500);
  return {
    id: crypto.randomUUID(),
    projectId,
    name,
    provider: provider as string,
    apiUrl: endpoint,
    ...(credential ? { encryptedCredential: encrypt(credential) } : {}),
    kinds: [...new Set(kinds)],
    categories: [...new Set(categories)] as StorageCategoryName[],
    autoKind: autoKind as string | null,
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
    createdBy: userId,
    createdAt: new Date(),
  };
}

export const summarizeProjectWorker = projectSummary;

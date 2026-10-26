import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { Auth, JobRecord, StorageAdapter, StreamByConfig, WorkerRef, WorkerResultMode } from '../types';
import { getModel } from '../models/manager';
import { createStorageProvider } from '../providers/storage';
import { nosqlDb } from '../utils/nosqlDb';
import { StorageCategory, validateContentType } from '../utils/assetCategories';
import { resolveStorageAdapter } from './connectionResolver';
import { archiveCurrentVersion, findVersion, recordFirstVersion, versionsCollection } from './assetVersions';
import { createJob, getJob, notify } from './jobQueue';
import { jobStore } from './jobStore';
import { assertPublicEndpoint, availableWorkers, PrivateEndpointError, resolveWorker, ResolvedWorker, WorkerError } from './workers';

// A worker's job, from start to end (the README has the contract a worker follows):
//
// 1. Asked for (a person, an agent, or a deliverable marked): it's kept as pending.
// 2. Sent to its worker: a POST to its endpoint with what to process, a short-lived URL to
//    download the asset, and where and how to call back (a token only this attempt has).
// 3. The worker calls back: asks where to upload its result, reports progress, and ends it
//    (complete, with a report; or fail, with its error).
// 4. Completed: the result is kept as a new version of the asset, or as a new asset derived
//    from it (the original is never touched), with the worker's report.
//
// A job that can't be sent, or that its worker doesn't finish in time, is sent again (up to
// workerOptions.maxAttempts); then it fails, with its error, and can be retried by hand.

export const WORKER_CALLBACK_PATH = '/worker-jobs';
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const DOWNLOAD_TTL_SECONDS = 3600;
const UPLOAD_TTL_SECONDS = 3600;

type RouterConfig = StreamByConfig & { adapter?: StorageAdapter };

const filesCollection = () => nosqlDb()?.collection('storage_files') ?? null;
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const extensionOf = (name: string) => (name.includes('.') ? `.${name.split('.').pop()!.toLowerCase()}` : '');

/**
 * As whom a job acts: whoever asked for it, with the platform role and name they had then, so
 * a host's canUseBuiltin decides on sending it as it did on asking for it.
 */
const authOf = (job: JobRecord): Auth => ({
  userId: job.userId,
  username: job.payload?.requester?.username ?? '',
  role: job.payload?.requester?.role ?? 'viewer',
});

const findProject = (projectId: string) => getModel('projects').findOne({ _id: projectId });

// The storage an asset is in: its storage connection's, or the default one.
async function fileAdapter(project: any, fileDoc: any, auth: Auth, config: RouterConfig): Promise<StorageAdapter> {
  const connId: string | undefined = fileDoc.storageConnectionId;
  if (connId && (project.storageConnections ?? []).some((c: any) => c.id === connId)) {
    const resolved = await resolveStorageAdapter(project, connId, config, auth);
    if ('error' in resolved) throw new WorkerError(resolved.error, resolved.status);
    return resolved;
  }
  return config.adapter || createStorageProvider(config.storageProviders);
}

export interface WorkerJobRequest {
  assetId: unknown;
  versionId?: unknown;
  worker: unknown;
  kind: unknown;
  profile?: unknown;
  resultMode?: unknown;
}

/** Asks a worker to process an asset, as `auth`: the job, pending, to be sent right away. */
export async function enqueueWorkerJob(
  project: any,
  request: WorkerJobRequest,
  auth: Auth,
  config: RouterConfig,
  callbackBase: string,
): Promise<JobRecord> {
  const projectId = String(project._id ?? project.id);
  if (typeof request.assetId !== 'string' || !request.assetId) throw new WorkerError('assetId is required');
  const ref = request.worker as { source?: unknown; id?: unknown } | undefined;
  if (!ref || typeof ref.id !== 'string' || typeof ref.source !== 'string') {
    throw new WorkerError("worker is required: { source: 'builtin' | 'project', id }");
  }
  const worker = await resolveWorker(project, { source: ref.source, id: ref.id }, auth, config);
  if (typeof request.kind !== 'string' || !worker.kinds.includes(request.kind)) {
    throw new WorkerError(`kind must be one of the worker's: ${worker.kinds.join(', ')}`);
  }
  const resultMode = (request.resultMode ?? 'derived') as WorkerResultMode;
  if (resultMode !== 'derived' && resultMode !== 'version') throw new WorkerError("resultMode must be 'derived' or 'version'");
  const profile = request.profile ?? {};
  if (typeof profile !== 'object' || Array.isArray(profile) || profile === null) throw new WorkerError('profile must be an object');

  const files = filesCollection();
  if (!files) throw new WorkerError('Database not available', 500);
  const fileDoc = await files.findOne({ fileId: request.assetId, projectId });
  if (!fileDoc) throw new WorkerError('Asset not found', 404);
  if (!worker.categories.includes(fileDoc.category)) {
    throw new WorkerError(`This worker takes ${worker.categories.join(', ')}, not ${fileDoc.category}`);
  }
  const versionId = typeof request.versionId === 'string' && request.versionId ? request.versionId : null;
  if (versionId && !(await findVersion(projectId, request.assetId, versionId))) throw new WorkerError('Version not found', 404);
  if (resultMode === 'version' && !(await fileAdapter(project, fileDoc, auth, config)).copyFile) {
    throw new WorkerError("This asset's storage can't keep versions: ask for a derived result", 400);
  }

  const requester = { role: auth.role, username: auth.username };
  const job = await createJob('process', auth.userId, projectId, { callbackBase, requester }, {
    assetId: request.assetId,
    versionId,
    worker: worker.ref,
    kind: request.kind,
    profile: profile as Record<string, unknown>,
    resultMode,
    attempts: 0,
    maxAttempts: config.workerOptions?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: new Date(),
  });
  kick(job.jobId, config);
  return job;
}

/** Runs the workers set to process, by themselves, an asset of their categories marked as a deliverable. */
export async function enqueueAutomaticJobs(project: any, assetId: string, versionId: string | null, auth: Auth, config: RouterConfig, callbackBase: string): Promise<JobRecord[]> {
  const projectId = String(project._id ?? project.id);
  const fileDoc = await filesCollection()?.findOne({ fileId: assetId, projectId });
  if (!fileDoc) return [];
  const jobs: JobRecord[] = [];
  for (const worker of await availableWorkers(project, auth, config)) {
    if (!worker.autoKind || !worker.categories.includes(fileDoc.category)) continue;
    try {
      jobs.push(await enqueueWorkerJob(project, { assetId, versionId, worker: { source: worker.source, id: worker.id }, kind: worker.autoKind }, auth, config, callbackBase));
    } catch (err) {
      console.error(`❌ StreamBy workers: couldn't start ${worker.name} for asset ${assetId}:`, err instanceof Error ? err.message : err);
    }
  }
  return jobs;
}

/** A failed worker job, back in line. */
export async function retryWorkerJob(jobId: string, config: RouterConfig): Promise<JobRecord | null> {
  const job = await jobStore().claim(jobId, ['failed'], {
    status: 'pending', stage: 'queued', progress: 0, error: null as unknown as undefined, attempts: 0,
    nextAttemptAt: new Date(), leaseUntil: null, callbackHash: null, upload: null, updatedAt: new Date(),
  });
  if (job) { notify(job); kick(job.jobId, config); }
  return job;
}

// ── Sending a job to its worker ──

const kick = (jobId: string, config: RouterConfig) => {
  setImmediate(() => { dispatchJob(jobId, config).catch(err => console.error('❌ StreamBy workers: dispatch failed:', err?.message ?? err)); });
};

const retryDelay = (attempts: number) => RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

/** Ends an attempt that went wrong: sent again later while attempts are left, or failed. */
async function attemptFailed(job: JobRecord, error: string): Promise<void> {
  const attempts = job.attempts ?? 1;
  const left = attempts < (job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const updated = await jobStore().update(job.jobId, left
    ? { status: 'pending', stage: 'retrying', error, nextAttemptAt: new Date(Date.now() + retryDelay(attempts)), leaseUntil: null, callbackHash: null, upload: null, updatedAt: new Date() }
    : { status: 'failed', stage: 'failed', error, leaseUntil: null, callbackHash: null, upload: null, updatedAt: new Date() });
  if (updated) notify(updated);
}

/**
 * Sends a pending job (or one its worker didn't finish in time) to its worker. Of several
 * instances, only the one that claims it does.
 */
export async function dispatchJob(jobId: string, config: RouterConfig): Promise<void> {
  const now = new Date();
  const current = await jobStore().get(jobId);
  if (!current?.worker) return;

  // Its worker had it and the time's up: sent again, or failed.
  if (current.status === 'processing') {
    if (!current.leaseUntil || new Date(current.leaseUntil) > now) return;
    const timedOut = await jobStore().claim(jobId, ['processing'], { leaseUntil: null, updatedAt: now }, { leaseEndedBy: now });
    if (timedOut) await attemptFailed(timedOut, "The worker didn't finish in time");
    return;
  }
  if (current.status !== 'pending' || (current.nextAttemptAt && new Date(current.nextAttemptAt) > now)) return;

  const project = await findProject(current.projectId);
  let worker: ResolvedWorker;
  try {
    if (!project) throw new WorkerError('Project not found', 404);
    worker = await resolveWorker(project, current.worker as WorkerRef, authOf(current), config);
  } catch (err) {
    const failed = await jobStore().claim(jobId, ['pending'], {
      status: 'failed', stage: 'failed', error: err instanceof Error ? err.message : String(err), updatedAt: now,
    });
    if (failed) notify(failed);
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const job = await jobStore().claim(jobId, ['pending'], {
    status: 'processing', stage: 'sent', attempts: (current.attempts ?? 0) + 1, callbackHash: hashOf(token),
    leaseUntil: new Date(now.getTime() + worker.timeoutSeconds * 1000), nextAttemptAt: null, updatedAt: now,
  });
  if (!job) return; // another instance took it
  notify(job);

  try {
    const files = filesCollection();
    const fileDoc = files && await files.findOne({ fileId: job.assetId, projectId: job.projectId });
    if (!fileDoc) throw new WorkerError('Asset not found', 404);
    const version = job.versionId ? await findVersion(job.projectId, job.assetId!, job.versionId) : null;
    if (job.versionId && !version) throw new WorkerError('Version not found', 404);
    const adapter = await fileAdapter(project, fileDoc, authOf(job), config);
    if (!adapter.getPresignedGetUrl) throw new WorkerError("This asset's storage can't give download URLs");
    const fileName = version?.fileName ?? fileDoc.displayName;
    const download = await adapter.getPresignedGetUrl(version?.storageKey ?? fileDoc.storageKey, DOWNLOAD_TTL_SECONDS, fileName);
    const callbackBase = config.workerOptions?.callbackBaseUrl ?? job.payload?.callbackBase;
    // A project's worker: its name may resolve, now, to the server's own network.
    if (worker.ref.source === 'project') await assertPublicEndpoint(worker.endpoint, config);

    const response = await fetch(worker.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(worker.credential ? { Authorization: `Bearer ${worker.credential}` } : {}) },
      body: JSON.stringify({
        jobId: job.jobId,
        kind: job.kind,
        profile: job.profile ?? {},
        attempt: job.attempts,
        asset: {
          id: job.assetId, versionId: version?.versionId ?? null, fileName,
          contentType: version?.contentType ?? fileDoc.contentType ?? null, category: fileDoc.category,
        },
        download: { url: download, expiresAt: new Date(now.getTime() + DOWNLOAD_TTL_SECONDS * 1000).toISOString() },
        callback: { url: `${String(callbackBase).replace(/\/$/, '')}${WORKER_CALLBACK_PATH}/${job.jobId}`, token },
        deadline: job.leaseUntil,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Its answer stays in the server's log: an endpoint's status isn't the user's to see.
      console.error(`❌ StreamBy workers: ${worker.ref.name} answered ${response.status} to job ${job.jobId}`);
      throw new Error('The worker refused the job');
    }
    const accepted = await jobStore().claim(jobId, ['processing'], { stage: 'accepted', updatedAt: new Date() }, { callbackHash: hashOf(token) });
    if (accepted) notify(accepted);
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'TimeoutError' ? "The worker didn't answer" : err.message) : String(err);
    // Only this attempt's own: the worker may have called back already.
    const still = await jobStore().get(jobId);
    if (still?.status !== 'processing' || still.callbackHash !== hashOf(token)) return;
    if (err instanceof PrivateEndpointError) {
      // Not sent, and never will be: no attempt is left for an endpoint at a private address.
      const failed = await jobStore().update(jobId, {
        status: 'failed', stage: 'failed', error: message, leaseUntil: null, callbackHash: null, upload: null, updatedAt: new Date(),
      });
      if (failed) notify(failed);
      return;
    }
    await attemptFailed(still, message);
  }
}

/** Looks, now and then, for jobs to send (again). Every instance does; claiming keeps them from doubling. */
export function startWorkerSweeper(config: RouterConfig): () => void {
  const interval = config.workerOptions?.sweepIntervalMs ?? 30_000;
  if (!interval) return () => {};
  const timer = setInterval(async () => {
    try {
      for (const job of await jobStore().due(new Date(), 20)) await dispatchJob(job.jobId, config);
    } catch (err) {
      console.error('❌ StreamBy workers: sweep failed:', err instanceof Error ? err.message : err);
    }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── The worker's callbacks ──

/** The job a callback is about, if its token is this attempt's and the job is in progress. */
export async function authorizeCallback(jobId: string, authorization: string | undefined): Promise<JobRecord> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) throw new WorkerError('A callback needs its job token (Authorization: Bearer ...)', 401);
  const job = await getJob(jobId);
  const expected = job?.callbackHash ? Buffer.from(job.callbackHash, 'hex') : null;
  const given = Buffer.from(hashOf(token), 'hex');
  if (!job || !expected || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new WorkerError('Invalid job token', 401);
  }
  if (job.status !== 'processing') throw new WorkerError(`The job is ${job.status}`, 409);
  return job;
}

export async function reportProgress(job: JobRecord, body: any): Promise<JobRecord | null> {
  const patch: Partial<JobRecord> = { updatedAt: new Date() };
  if (body?.progress !== undefined) {
    const progress = Number(body.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new WorkerError('progress must be from 0 to 100');
    patch.progress = Math.round(progress);
  }
  if (body?.stage !== undefined) {
    if (typeof body.stage !== 'string' || !body.stage.trim() || body.stage.length > 60) throw new WorkerError('stage must be a short text');
    patch.stage = body.stage.trim();
  }
  const updated = await jobStore().claim(job.jobId, ['processing'], patch);
  if (updated) notify(updated);
  return updated;
}

/** Where the worker uploads its result: a key of its own until the job completes. */
export async function resultUploadUrl(job: JobRecord, body: any, config: RouterConfig) {
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
  const contentType = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
  if (!fileName || !contentType || fileName.includes('/')) throw new WorkerError('fileName and contentType are required');
  const project = await findProject(job.projectId);
  const fileDoc = await filesCollection()?.findOne({ fileId: job.assetId, projectId: job.projectId });
  if (!project || !fileDoc) throw new WorkerError('Asset not found', 404);
  if (!validateContentType(contentType, fileName, fileDoc.category as StorageCategory)) {
    throw new WorkerError(`The result must be of the asset's category, ${fileDoc.category}`);
  }
  const adapter = await fileAdapter(project, fileDoc, authOf(job), config);
  if (!adapter.getPresignedUploadUrl) throw new WorkerError("This asset's storage can't give upload URLs");

  const storageKey = job.resultMode === 'version'
    ? `${String(fileDoc.storageKey).replace(/\.[^./]*$/, '')}.job-${job.jobId}${extensionOf(fileName)}`
    : `${job.projectId}/${fileDoc.category}/${crypto.randomUUID()}${extensionOf(fileName)}`;
  const url = await adapter.getPresignedUploadUrl(storageKey, contentType, UPLOAD_TTL_SECONDS);
  const updated = await jobStore().claim(job.jobId, ['processing'], {
    upload: { storageKey, fileName, contentType }, stage: 'uploading', updatedAt: new Date(),
  });
  if (!updated) throw new WorkerError('The job is no longer in progress', 409);
  notify(updated);
  return {
    url, method: 'PUT', headers: { 'Content-Type': contentType },
    expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
  };
}

/** The worker's result, kept: a new version of the asset, or a new asset derived from it. */
export async function completeJob(job: JobRecord, body: any, config: RouterConfig): Promise<JobRecord> {
  if (!job.upload) throw new WorkerError('Upload the result first (upload-url)', 409);
  const report = body?.report ?? null;
  if (report !== null && (typeof report !== 'object' || Array.isArray(report))) throw new WorkerError('report must be an object');
  if (JSON.stringify(report ?? {}).length > 64_000) throw new WorkerError('report is too large');

  // Claimed first, its token spent: a second callback (or a timeout) can't complete it twice.
  const claimed = await jobStore().claim(job.jobId, ['processing'], { stage: 'saving', leaseUntil: null, callbackHash: null, updatedAt: new Date() }, { callbackHash: job.callbackHash ?? '' });
  if (!claimed) throw new WorkerError('The job is no longer in progress', 409);
  try {
    const result = await keepResult(job, report, config);
    const done = await jobStore().update(job.jobId, {
      status: 'completed', stage: 'complete', progress: 100, error: null as unknown as undefined, report, result, upload: null, updatedAt: new Date(),
    });
    if (done) notify(done);
    return done!;
  } catch (err) {
    const failed = await jobStore().update(job.jobId, {
      status: 'failed', stage: 'failed', error: `Its result couldn't be kept: ${err instanceof Error ? err.message : err}`, updatedAt: new Date(),
    });
    if (failed) notify(failed);
    throw err;
  }
}

async function keepResult(job: JobRecord, report: Record<string, unknown> | null, config: RouterConfig): Promise<NonNullable<JobRecord['result']>> {
  const project = await findProject(job.projectId);
  const files = filesCollection();
  const fileDoc = files && await files.findOne({ fileId: job.assetId, projectId: job.projectId });
  if (!project || !files || !fileDoc) throw new WorkerError('Asset not found', 404);
  const adapter = await fileAdapter(project, fileDoc, authOf(job), config);
  const { storageKey, fileName, contentType } = job.upload!;
  const meta = { report, jobId: job.jobId, kind: job.kind, worker: job.worker };

  let result: NonNullable<JobRecord['result']>;
  if (job.resultMode === 'version') {
    if (!adapter.copyFile) throw new WorkerError("This asset's storage can't keep versions", 400);
    // The asset keeps its key (and URL): its current version is archived, the result takes its place.
    const version = await archiveCurrentVersion(fileDoc as any, { fileName, contentType, userId: job.userId }, adapter.copyFile.bind(adapter));
    await adapter.copyFile(storageKey, fileDoc.storageKey);
    if (adapter.deleteFile) await adapter.deleteFile(storageKey).catch(() => { /* a leftover upload only */ });
    await files.updateOne({ fileId: job.assetId, projectId: job.projectId }, { $set: { contentType, updatedAt: new Date() } });
    await versionsCollection()?.updateOne({ versionId: version.versionId }, { $set: meta });
    result = { assetId: job.assetId!, versionId: version.versionId, mode: 'version' };
  } else {
    // A new asset, linked to the one (and the version) it came from.
    const fileId = crypto.randomUUID();
    const derived = {
      _id: new ObjectId(), fileId, projectId: job.projectId,
      ...(fileDoc.storageConnectionId ? { storageConnectionId: fileDoc.storageConnectionId } : {}),
      category: fileDoc.category, storageKey, displayName: fileName, contentType,
      uploadedBy: job.userId, createdAt: new Date(), folderId: fileDoc.folderId ?? null,
      derivedFrom: { assetId: job.assetId, versionId: job.versionId ?? null, jobId: job.jobId, kind: job.kind },
    };
    await files.insertOne(derived);
    await recordFirstVersion(derived);
    const [first] = (await versionsCollection()?.find({ assetId: fileId, projectId: job.projectId }).limit(1).toArray()) ?? [];
    if (first) await versionsCollection()?.updateOne({ versionId: first.versionId }, { $set: meta });
    result = { assetId: fileId, versionId: first?.versionId ?? '', mode: 'derived' };
  }
  return result;
}

/** The worker couldn't do it: sent again if it says it may work later (and attempts are left), or failed. */
export async function failWorkerJob(job: JobRecord, body: any, config: RouterConfig): Promise<JobRecord | null> {
  const error = typeof body?.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 2000) : 'The worker failed';
  const claimed = await jobStore().claim(job.jobId, ['processing'], { leaseUntil: null, callbackHash: null, updatedAt: new Date() }, { callbackHash: job.callbackHash ?? '' });
  if (!claimed) throw new WorkerError('The job is no longer in progress', 409);
  await discardUpload(claimed, config);
  if (body?.retryable === true) await attemptFailed(claimed, error);
  else {
    const failed = await jobStore().update(job.jobId, { status: 'failed', stage: 'failed', error, callbackHash: null, upload: null, updatedAt: new Date() });
    if (failed) notify(failed);
  }
  return jobStore().get(job.jobId);
}

// A failed attempt's upload, if any, isn't kept.
async function discardUpload(job: JobRecord, config: RouterConfig) {
  if (!job.upload) return;
  try {
    const project = await findProject(job.projectId);
    const fileDoc = await filesCollection()?.findOne({ fileId: job.assetId, projectId: job.projectId });
    if (!project || !fileDoc) return;
    const adapter = await fileAdapter(project, fileDoc, authOf(job), config);
    await adapter.deleteFile?.(job.upload.storageKey);
  } catch { /* a leftover upload only */ }
}

/** What's shown of a job: never its callback token's hash, nor its upload's key. */
export const publicJob = ({ callbackHash: _hash, upload: _upload, payload, ...job }: JobRecord) => ({
  ...job,
  payload: job.jobType === 'process' ? {} : payload,
});

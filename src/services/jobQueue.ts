import crypto from 'crypto';
import { JobRecord, JobType } from '../types';
import { emitToUser } from './wsHub';
import { jobStore } from './jobStore';

// Jobs, kept in the main database (see jobStore): they survive restarts and every instance
// sees them. Each change is sent to whoever started the job (a `jobEvent`).

export async function createJob(
  jobType: JobType,
  userId: string,
  projectId: string,
  payload: Record<string, any>,
  extra: Partial<JobRecord> = {},
): Promise<JobRecord> {
  const now = new Date();
  const job: JobRecord = {
    jobId: crypto.randomUUID(),
    jobType,
    userId,
    projectId,
    status: 'pending',
    stage: 'queued',
    progress: 0,
    payload,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  const saved = await jobStore().insert(job);
  notify(saved);
  return saved;
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  return jobStore().get(jobId);
}

export async function listJobs(projectId: string, assetId?: string): Promise<JobRecord[]> {
  return jobStore().list({ projectId, assetId });
}

export function notify(job: JobRecord): void {
  emitToUser(job.userId, {
    type: 'jobEvent',
    data: {
      jobId: job.jobId,
      jobType: job.jobType,
      projectId: job.projectId,
      assetId: job.assetId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.stage,
      error: job.error,
    },
  });
}

export async function updateJob(jobId: string, updates: Partial<JobRecord>): Promise<JobRecord | null> {
  const job = await jobStore().update(jobId, { ...updates, updatedAt: new Date() });
  if (job) notify(job);
  return job;
}

export async function failJob(jobId: string, error: string): Promise<JobRecord | null> {
  return updateJob(jobId, { status: 'failed', stage: 'failed', error });
}

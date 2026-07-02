import crypto from 'crypto';
import { JobRecord, JobType, JobStatus } from '../types';
import { emitToUser } from './wsHub';

const jobs = new Map<string, JobRecord>();

export function createJob(
  jobType: JobType,
  userId: string,
  projectId: string,
  payload: Record<string, any>,
): JobRecord {
  const jobId = crypto.randomUUID();
  const now = new Date();
  const job: JobRecord = {
    jobId,
    jobType,
    userId,
    projectId,
    status: 'pending',
    stage: 'queued',
    progress: 0,
    payload,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): JobRecord | undefined {
  return jobs.get(jobId);
}

export function updateJob(
  jobId: string,
  updates: Partial<Pick<JobRecord, 'status' | 'stage' | 'progress' | 'assetId' | 'error'>>,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates, { updatedAt: new Date() });
  emitToUser(job.userId, {
    type: 'jobEvent',
    data: {
      jobId: job.jobId,
      jobType: job.jobType,
      assetId: job.assetId,
      stage: job.stage,
      progress: job.progress,
      message: updates.stage,
      error: job.error,
    },
  });
}

export function failJob(jobId: string, error: string): void {
  updateJob(jobId, { status: 'failed', stage: 'failed', error });
}

import { Router, Request, Response } from 'express';
import { Auth, StorageAdapter, StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { listJobs, getJob } from '../../services/jobQueue';
import {
  availableWorkers, newWorkerConnection, projectWorkers, summarizeProjectWorker, WorkerError,
} from '../../services/workers';
import { enqueueWorkerJob, publicJob, retryWorkerJob } from '../../services/workerJobs';

/** Where workers call back to: this router, as the request reached it (unless the host says). */
export const callbackBaseOf = (req: Request, config: StreamByConfig) =>
  config.workerOptions?.callbackBaseUrl ?? `${req.protocol}://${req.get('host')}${req.baseUrl}`;

// A project's processing workers (its own and the host's), and its jobs: asking a worker to
// process an asset, following them, and retrying a failed one.
export function workerRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();
  const Project = getModel('projects');

  const failed = (res: Response, what: string, err: any) => {
    if (err instanceof WorkerError) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: `Failed to ${what}`, details: err?.message });
  };

  const projectFor = async (req: Request, res: Response, edit: boolean) => {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.projectId });
    if (!project) {
      res.status(404).json({ message: 'Project not found' });
      return null;
    }
    if (!(edit ? canEditProject : isProjectMember)(project, auth.userId)) {
      res.status(403).json({ message: 'Unauthorized' });
      return null;
    }
    return project;
  };

  // ── Workers ──

  router.get('/projects/:projectId/workers', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, false);
      if (!project) return;
      res.json({ data: await availableWorkers(project, (req as any).auth, config) });
    } catch (err) {
      failed(res, 'list workers', err);
    }
  });

  router.post('/projects/:projectId/workers', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await projectFor(req, res, true);
      if (!project) return;
      const worker = newWorkerConnection(req.body ?? {}, req.params.projectId, auth.userId, config);
      await Project.update({ _id: req.params.projectId }, { $push: { renderFarmConnections: worker } } as any);
      res.status(201).json({ data: summarizeProjectWorker(worker) });
    } catch (err) {
      failed(res, 'connect the worker', err);
    }
  });

  router.delete('/projects/:projectId/workers/:workerId', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, true);
      if (!project) return;
      if (!projectWorkers(project).some(w => w.id === req.params.workerId)) return res.status(404).json({ message: 'Worker not found' });
      await Project.update({ _id: req.params.projectId }, { $pull: { renderFarmConnections: { id: req.params.workerId } } } as any);
      res.json({ message: 'Worker removed' });
    } catch (err) {
      failed(res, 'remove the worker', err);
    }
  });

  // ── Jobs ──

  router.get('/projects/:projectId/jobs', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, false);
      if (!project) return;
      const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
      res.json({ data: (await listJobs(req.params.projectId, assetId)).map(publicJob) });
    } catch (err) {
      failed(res, 'list jobs', err);
    }
  });

  // A worker processes an asset (or one of its versions): { assetId, versionId?, worker:
  // { source, id }, kind, profile?, resultMode?: 'derived' | 'version' }.
  router.post('/projects/:projectId/jobs/process', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, true);
      if (!project) return;
      const job = await enqueueWorkerJob(project, req.body ?? {}, (req as any).auth, config, callbackBaseOf(req, config));
      res.status(202).json({ job: publicJob(job) });
    } catch (err) {
      failed(res, 'start the job', err);
    }
  });

  router.post('/projects/:projectId/jobs/:jobId/retry', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, true);
      if (!project) return;
      const job = await getJob(req.params.jobId);
      if (!job || job.projectId !== req.params.projectId) return res.status(404).json({ message: 'Job not found' });
      if (!job.worker) return res.status(400).json({ message: 'Only a worker job can be retried' });
      const retried = await retryWorkerJob(job.jobId, config);
      if (!retried) return res.status(409).json({ message: `Only a failed job can be retried; this one is ${job.status}` });
      res.status(202).json({ job: publicJob(retried) });
    } catch (err) {
      failed(res, 'retry the job', err);
    }
  });

  return router;
}

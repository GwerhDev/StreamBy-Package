import { Router, Request, Response } from 'express';
import { StorageAdapter, StreamByConfig } from '../../types';
import { WorkerError } from '../../services/workers';
import {
  authorizeCallback, completeJob, failWorkerJob, publicJob, reportProgress, resultUploadUrl, WORKER_CALLBACK_PATH,
} from '../../services/workerJobs';

// A worker calling back about the job it was sent: with no session, only the job's own token
// (`Authorization: Bearer <callback.token>`), which works for that attempt alone.
export function workerCallbackRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();

  const handle = (action: (job: any, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const job = await authorizeCallback(req.params.jobId, req.headers.authorization);
      res.json(await action(job, req));
    } catch (err: any) {
      if (err instanceof WorkerError) return res.status(err.status).json({ message: err.message });
      console.error('❌ StreamBy workers: callback failed:', err?.message ?? err);
      res.status(500).json({ message: 'Callback failed' });
    }
  };

  router.post(`${WORKER_CALLBACK_PATH}/:jobId/progress`, handle(async (job, req) => ({ job: publicJob((await reportProgress(job, req.body)) ?? job) })));
  router.post(`${WORKER_CALLBACK_PATH}/:jobId/upload-url`, handle((job, req) => resultUploadUrl(job, req.body, config)));
  router.post(`${WORKER_CALLBACK_PATH}/:jobId/complete`, handle(async (job, req) => ({ job: publicJob(await completeJob(job, req.body, config)) })));
  router.post(`${WORKER_CALLBACK_PATH}/:jobId/fail`, handle(async (job, req) => {
    const after = await failWorkerJob(job, req.body, config);
    return { job: after ? publicJob(after) : null };
  }));

  return router;
}

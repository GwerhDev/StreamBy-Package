import { Router, Request, Response } from 'express';
import { Auth, StorageAdapter, StreamByConfig } from '../../types';
import { WorkerError } from '../../services/workers';
import {
  runnerByToken, checkDeclaration, keepDeclaration, listOwnRunners, registerRunner, revokeRunner, shareRunner,
  unshareRunner, waitForRunnerJob,
} from '../../services/workerRunners';
import { failRunnerJobs, returnRunnerJob, takeRunnerJob } from '../../services/workerJobs';
import { callbackBaseOf } from './worker';

type RouterConfig = StreamByConfig & { adapter?: StorageAdapter };

const DEFAULT_POLL_WAIT_MS = 25_000;
// How often a waiting poll looks again (a job queued on another instance doesn't wake it).
const LOOK_AGAIN_MS = 3_000;

const failed = (res: Response, what: string, err: any) => {
  if (err instanceof WorkerError) return res.status(err.status).json({ message: err.message });
  console.error(`❌ StreamBy runners: failed to ${what}:`, err?.message ?? err);
  res.status(500).json({ message: `Failed to ${what}` });
};

// A runner asking for a job: with no session, only its own token (`Authorization: Bearer
// sbr_...`). It declares what it can do now; the answer waits (up to 25 seconds) for a job it
// can do: 200 with the job (as a worker is sent one), or 204, and it asks again.
export function workerRunnerPollRouter(config: RouterConfig): Router {
  const router = Router();

  router.post('/runner/jobs/next', async (req: Request, res: Response) => {
    try {
      const runner = await runnerByToken(req.headers.authorization);
      if (!runner) return res.status(401).json({ message: "A runner asks with its own token (Authorization: Bearer sbr_...)" });
      const declared = checkDeclaration(req.body);
      const current = await keepDeclaration(runner, declared);

      // Asked by a runner that's gone (its connection closed): it stops waiting.
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      const waitMs = config.workerOptions?.runnerPollWaitMs ?? DEFAULT_POLL_WAIT_MS;
      const until = Date.now() + waitMs;
      while (!gone.signal.aborted) {
        const job = await takeRunnerJob(current, declared, callbackBaseOf(req, config), config);
        if (job) {
          // Taken for a runner that left meanwhile: back in line, for its next poll.
          if (gone.signal.aborted || res.destroyed) await returnRunnerJob(job.jobId, job.callback.token);
          else res.json({ job });
          return;
        }
        const left = until - Date.now();
        if (left <= 0) break;
        await waitForRunnerJob(current.id, Math.min(left, LOOK_AGAIN_MS), gone.signal);
      }
      if (!res.destroyed) res.status(204).end();
    } catch (err) {
      failed(res, 'hand out a job', err);
    }
  });

  return router;
}

// A user's own runners, managed only with a session (no API token reaches these routes): they
// register them (each one's token shown once), share them with projects or teams of projects
// they're in, and revoke them.
export function workerRunnerRouter(config: RouterConfig): Router {
  const router = Router();
  const authOf = (req: Request) => (req as any).auth as Auth;

  router.get('/user/runners', async (req: Request, res: Response) => {
    try {
      res.json({ data: await listOwnRunners(authOf(req).userId) });
    } catch (err) {
      failed(res, 'list runners', err);
    }
  });

  router.post('/user/runners', async (req: Request, res: Response) => {
    try {
      const { token, runner } = await registerRunner(authOf(req), req.body, config);
      res.status(201).json({ token, data: runner, message: 'Copy the token now: it will not be shown again' });
    } catch (err) {
      failed(res, 'register the runner', err);
    }
  });

  router.delete('/user/runners/:runnerId', async (req: Request, res: Response) => {
    try {
      if (!(await revokeRunner(authOf(req).userId, req.params.runnerId))) return res.status(404).json({ message: 'Runner not found' });
      await failRunnerJobs(req.params.runnerId, config);
      res.json({ message: 'Runner revoked' });
    } catch (err) {
      failed(res, 'revoke the runner', err);
    }
  });

  // { projectId, teamId? }: with the project, or only with one of its teams.
  router.post('/user/runners/:runnerId/shares', async (req: Request, res: Response) => {
    try {
      res.status(201).json({ data: await shareRunner(authOf(req), req.params.runnerId, req.body, config) });
    } catch (err) {
      failed(res, 'share the runner', err);
    }
  });

  router.delete('/user/runners/:runnerId/shares/:shareId', async (req: Request, res: Response) => {
    try {
      if (!(await unshareRunner(authOf(req).userId, req.params.runnerId, req.params.shareId))) return res.status(404).json({ message: 'Share not found' });
      res.json({ message: 'No longer shared there' });
    } catch (err) {
      failed(res, 'stop sharing the runner', err);
    }
  });

  return router;
}

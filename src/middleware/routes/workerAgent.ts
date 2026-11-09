import { Router, Request, Response } from 'express';
import { Auth, StorageAdapter, StreamByConfig } from '../../types';
import { WorkerError } from '../../services/workers';
import {
  agentByToken, checkDeclaration, keepDeclaration, listOwnAgents, registerAgent, revokeAgent, shareAgent,
  unshareAgent, waitForAgentJob,
} from '../../services/workerAgents';
import { failAgentJobs, returnAgentJob, takeAgentJob } from '../../services/workerJobs';
import { callbackBaseOf } from './worker';

type RouterConfig = StreamByConfig & { adapter?: StorageAdapter };

const DEFAULT_POLL_WAIT_MS = 25_000;
// How often a waiting poll looks again (a job queued on another instance doesn't wake it).
const LOOK_AGAIN_MS = 3_000;

const failed = (res: Response, what: string, err: any) => {
  if (err instanceof WorkerError) return res.status(err.status).json({ message: err.message });
  console.error(`❌ StreamBy agents: failed to ${what}:`, err?.message ?? err);
  res.status(500).json({ message: `Failed to ${what}` });
};

// An agent asking for a job: with no session, only its own token (`Authorization: Bearer
// sba_...`). It declares what it can do now; the answer waits (up to 25 seconds) for a job it
// can do: 200 with the job (as a worker is sent one), or 204, and it asks again.
export function workerAgentPollRouter(config: RouterConfig): Router {
  const router = Router();

  router.post('/worker-agent/jobs/next', async (req: Request, res: Response) => {
    try {
      const agent = await agentByToken(req.headers.authorization);
      if (!agent) return res.status(401).json({ message: "An agent asks with its own token (Authorization: Bearer sba_...)" });
      const declared = checkDeclaration(req.body);
      const current = await keepDeclaration(agent, declared);

      // Asked by an agent that's gone (its connection closed): it stops waiting.
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      const waitMs = config.workerOptions?.agentPollWaitMs ?? DEFAULT_POLL_WAIT_MS;
      const until = Date.now() + waitMs;
      while (!gone.signal.aborted) {
        const job = await takeAgentJob(current, declared, callbackBaseOf(req, config), config);
        if (job) {
          // Taken for an agent that left meanwhile: back in line, for its next poll.
          if (gone.signal.aborted || res.destroyed) await returnAgentJob(job.jobId, job.callback.token);
          else res.json({ job });
          return;
        }
        const left = until - Date.now();
        if (left <= 0) break;
        await waitForAgentJob(current.id, Math.min(left, LOOK_AGAIN_MS), gone.signal);
      }
      if (!res.destroyed) res.status(204).end();
    } catch (err) {
      failed(res, 'hand out a job', err);
    }
  });

  return router;
}

// A user's own agents, managed only with a session (no API token reaches these routes): they
// register them (each one's token shown once), share them with projects or teams of projects
// they're in, and revoke them.
export function workerAgentRouter(config: RouterConfig): Router {
  const router = Router();
  const authOf = (req: Request) => (req as any).auth as Auth;

  router.get('/user/worker-agents', async (req: Request, res: Response) => {
    try {
      res.json({ data: await listOwnAgents(authOf(req).userId) });
    } catch (err) {
      failed(res, 'list agents', err);
    }
  });

  router.post('/user/worker-agents', async (req: Request, res: Response) => {
    try {
      const { token, agent } = await registerAgent(authOf(req), req.body, config);
      res.status(201).json({ token, data: agent, message: 'Copy the token now: it will not be shown again' });
    } catch (err) {
      failed(res, 'register the agent', err);
    }
  });

  router.delete('/user/worker-agents/:agentId', async (req: Request, res: Response) => {
    try {
      if (!(await revokeAgent(authOf(req).userId, req.params.agentId))) return res.status(404).json({ message: 'Agent not found' });
      await failAgentJobs(req.params.agentId, config);
      res.json({ message: 'Agent revoked' });
    } catch (err) {
      failed(res, 'revoke the agent', err);
    }
  });

  // { projectId, teamId? }: with the project, or only with one of its teams.
  router.post('/user/worker-agents/:agentId/shares', async (req: Request, res: Response) => {
    try {
      res.status(201).json({ data: await shareAgent(authOf(req), req.params.agentId, req.body, config) });
    } catch (err) {
      failed(res, 'share the agent', err);
    }
  });

  router.delete('/user/worker-agents/:agentId/shares/:shareId', async (req: Request, res: Response) => {
    try {
      if (!(await unshareAgent(authOf(req).userId, req.params.agentId, req.params.shareId))) return res.status(404).json({ message: 'Share not found' });
      res.json({ message: 'No longer shared there' });
    } catch (err) {
      failed(res, 'stop sharing the agent', err);
    }
  });

  return router;
}

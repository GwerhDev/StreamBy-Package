import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { ApiTokenError, createApiToken, listApiTokens, revokeApiToken } from '../../services/apiTokens';

// The signed-in user's own API tokens (see services/apiTokens): listed, made, revoked. Only
// with a session: a token can't manage tokens (see enforceApiTokenScope).
export function apiTokenRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  router.get('/user/api-tokens', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      res.json({ apiTokens: await listApiTokens(auth.userId) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list API tokens', details: err.message });
    }
  });

  // The token itself is in this response only: it's never stored, nor shown again.
  router.post('/user/api-tokens', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { name, access, projectIds, expiresInDays } = req.body ?? {};
      // A token reaches only projects its owner is in.
      if (Array.isArray(projectIds)) {
        for (const id of projectIds) {
          const project = typeof id === 'string' ? await Project.findOne({ _id: id }) : null;
          if (!isProjectMember(project, auth.userId)) {
            return res.status(400).json({ message: `You are not a member of project '${id}'` });
          }
        }
      }
      const { token, info } = await createApiToken(auth.userId, { name, access, projectIds, expiresInDays: expiresInDays ?? null }, config);
      res.status(201).json({ token, apiToken: info, message: 'Copy the token now: it will not be shown again' });
    } catch (err: any) {
      if (err instanceof ApiTokenError) return res.status(err.status).json({ message: err.message });
      res.status(500).json({ message: 'Failed to create API token', details: err.message });
    }
  });

  router.delete('/user/api-tokens/:tokenId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const revoked = await revokeApiToken(auth.userId, req.params.tokenId);
      if (!revoked) return res.status(404).json({ message: 'API token not found' });
      res.status(204).end();
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to revoke API token', details: err.message });
    }
  });

  return router;
}

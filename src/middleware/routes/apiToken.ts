import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';
import { activeMemberOf, isProjectAdmin, isProjectMember } from '../../utils/auth';
import {
  ApiTokenError, ApiTokenInfo, createApiToken, listProjectApiTokens, listUserApiTokens,
  revokeProjectApiToken, revokeUserApiToken,
} from '../../services/apiTokens';

// API tokens (see services/apiTokens), managed only with a session: no route here is
// reachable with a token (see apiTokenPermissions).
//
// - A user's own: listed, made and revoked by them.
// - A project's: listed, made and revoked by its admins only.
export function apiTokenRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  const failed = (res: Response, what: string, err: any) => {
    if (err instanceof ApiTokenError) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: `Failed to ${what}`, details: err.message });
  };

  // The token itself is in the response that makes it only: it's never stored, nor shown again.
  const created = (res: Response, token: string, info: ApiTokenInfo) =>
    res.status(201).json({ token, apiToken: info, message: 'Copy the token now: it will not be shown again' });

  router.get('/user/api-tokens', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      res.json({ apiTokens: await listUserApiTokens(auth.userId) });
    } catch (err: any) {
      failed(res, 'list API tokens', err);
    }
  });

  router.post('/user/api-tokens', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { name, permissions, projectIds, expiresInDays } = req.body ?? {};
      // A token reaches only projects its owner is in.
      if (Array.isArray(projectIds)) {
        for (const id of projectIds) {
          const project = typeof id === 'string' ? await Project.findOne({ _id: id }) : null;
          if (!isProjectMember(project, auth.userId)) {
            return res.status(400).json({ message: `You are not a member of project '${id}'` });
          }
        }
      }
      const { token, info } = await createApiToken(
        { kind: 'user', userId: auth.userId, username: auth.username },
        { name, permissions, projectIds, expiresInDays: expiresInDays ?? null },
        config,
      );
      created(res, token, info);
    } catch (err: any) {
      failed(res, 'create API token', err);
    }
  });

  router.delete('/user/api-tokens/:tokenId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (!(await revokeUserApiToken(auth.userId, req.params.tokenId))) {
        return res.status(404).json({ message: 'API token not found' });
      }
      res.status(204).end();
    } catch (err: any) {
      failed(res, 'revoke API token', err);
    }
  });

  // ── A project's tokens: its admins only ──

  const adminsProject = async (req: Request, res: Response) => {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.id });
    if (!project) {
      res.status(404).json({ message: 'Project not found' });
      return null;
    }
    if (!isProjectAdmin(project, auth.userId)) {
      res.status(403).json({ message: "Only a project admin manages the project's API tokens" });
      return null;
    }
    return project;
  };

  router.get('/projects/:id/api-tokens', async (req: Request, res: Response) => {
    try {
      const project = await adminsProject(req, res);
      if (!project) return;
      // Whether whoever made each one is still in the project: it keeps working if they aren't.
      const apiTokens = (await listProjectApiTokens(req.params.id)).map(token => ({
        ...token,
        createdBy: { ...token.createdBy, isMember: !!activeMemberOf(project, token.createdBy.userId) },
      }));
      res.json({ apiTokens });
    } catch (err: any) {
      failed(res, "list the project's API tokens", err);
    }
  });

  router.post('/projects/:id/api-tokens', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (!(await adminsProject(req, res))) return;
      const { name, permissions, expiresInDays } = req.body ?? {};
      const { token, info } = await createApiToken(
        { kind: 'project', userId: auth.userId, username: auth.username, projectId: req.params.id },
        { name, permissions, expiresInDays: expiresInDays ?? null },
        config,
      );
      created(res, token, info);
    } catch (err: any) {
      failed(res, "create the project's API token", err);
    }
  });

  router.delete('/projects/:id/api-tokens/:tokenId', async (req: Request, res: Response) => {
    try {
      if (!(await adminsProject(req, res))) return;
      if (!(await revokeProjectApiToken(req.params.id, req.params.tokenId))) {
        return res.status(404).json({ message: 'API token not found' });
      }
      res.status(204).end();
    } catch (err: any) {
      failed(res, "revoke the project's API token", err);
    }
  });

  return router;
}

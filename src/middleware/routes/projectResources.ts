import { Router, Request, Response } from 'express';
import { Auth, StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { dependentsOf, findResource, RESOURCE_KINDS, ResourceKind } from '../../services/dependents';

// A project's resources as a whole: what depends on one, asked before removing it.
export function projectResourcesRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  async function projectFor(req: Request, res: Response, edit = false) {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.id });
    if (!project) { res.status(404).json({ message: 'Project not found' }); return null; }
    if (!(edit ? canEditProject : isProjectMember)(project, auth.userId)) { res.status(403).json({ message: 'Unauthorized project access' }); return null; }
    return { project, auth };
  }

  router.get('/projects/:id/dependents/:kind/:resourceId', async (req: Request, res: Response) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      const kind = req.params.kind as ResourceKind;
      if (!RESOURCE_KINDS.includes(kind)) return res.status(400).json({ message: `kind is one of: ${RESOURCE_KINDS.join(', ')}` });
      if (!findResource(found.project, kind, req.params.resourceId)) return res.status(404).json({ message: 'Not found in this project' });
      res.json({ dependents: await dependentsOf(found.project, kind, req.params.resourceId) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

/** A built-in disconnected: its id kept, to connect it again as it was (services/projectIntegration). */
export async function rememberDisconnectedBuiltin(projectId: string, kind: 'db' | 'storage', conn: { id: string; integrationId?: string }) {
  if (!conn.integrationId) return;
  const Project = getModel('projects');
  await Project.update({ _id: projectId }, { $pull: { disconnectedBuiltins: { integrationId: conn.integrationId } } });
  await Project.update({ _id: projectId }, { $push: { disconnectedBuiltins: { kind, integrationId: conn.integrationId, connectionId: conn.id } } });
}

import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';

export function exportRouter(config: StreamByConfig): Router {
  const router = Router();

  const Project = getModel('projects');
  const Export = getModel('exports');

  router.get('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const exportId = req.params.export_id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }

      const data = await Export.findOne({ _id: exportId });

      res.json({ data: { ...data, id: data._id || data.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch export data', details: err.message });
    }
  });

  router.post('/projects/:id/exports', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const { name, description, collectionName } = req.body;

      if (!name || !collectionName) {
        return res.status(400).json({ error: 'Missing export name or collectionName' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const newExport = await Export.create({
        name,
        description,
        collectionName,
        projectId
      });

      res.status(201).json({ data: { ...newExport, id: newExport._id || newExport.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create export', details: err.message });
    }
  });

  return router;
}

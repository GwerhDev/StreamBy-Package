import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { createExport, createRawExport } from '../../services/export';

export function exportRouter(config: StreamByConfig): Router {
  const router = Router();

  const Project = getModel('projects');

  router.get('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const exportId = req.params.export_id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized access' });
      }
      const Export = getModel('exports', project.dbType);
      const data = await Export.findOne({ _id: exportId });

      res.json({ data: { ...data, id: data._id || data.id, _id: undefined }, message: 'Export data fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch export data', details: err.message });
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
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const { name, description, collectionName, fields } = req.body;

      if (!name || !collectionName || !fields) {
        return res.status(400).json({ message: 'Missing export name, collectionName, or fields' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const result = await createExport(config, projectId, name, collectionName, fields, project.dbType);

      res.status(201).json({ data: result, message: result.message });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create export', details: err.message });
    }
  });

  router.post('/projects/:id/exports/raw', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const { name, description, collectionName, jsonData } = req.body;

      if (!name || !collectionName || !jsonData) {
        return res.status(400).json({ message: 'Missing export name, collectionName, or jsonData' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }
      
      const result = await createRawExport(config, projectId, name, collectionName, jsonData, project.dbType);

      res.status(201).json({ data: result, message: result.message });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create raw export', details: err.message });
    }
  });

  return router;
}

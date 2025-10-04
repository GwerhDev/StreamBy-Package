import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { addCredential, updateCredential, deleteCredential } from '../../services/credential';

export function credentialRouter(config: StreamByConfig): Router {
  const router = Router();

  const Project = getModel('projects');

  // Add a new credential to a project
  router.post('/projects/:id/credentials', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { id, key, value } = req.body;

      if (!key || !value) {
        return res.status(400).json({ message: 'Missing credential key or value' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updatedProject = await addCredential(config, projectId, { id, key, value });

      res.status(201).json({ message: 'Credential added successfully', project: updatedProject });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add credential', details: err.message });
    }
  });

  // Update an existing credential in a project
  router.patch('/projects/:id/credentials/:credentialId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const credentialId = req.params.credentialId;
      const { key, value } = req.body;

      if (!key && !value) {
        return res.status(400).json({ message: 'No update fields provided' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updatedProject = await updateCredential(config, projectId, credentialId, { key, value });

      res.status(200).json({ message: 'Credential updated successfully', project: updatedProject });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update credential', details: err.message });
    }
  });

  // Delete a credential from a project
  router.delete('/projects/:id/credentials/:credentialId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const credentialId = req.params.credentialId;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updatedProject = await deleteCredential(config, projectId, credentialId);

      res.status(200).json({ message: 'Credential deleted successfully', project: updatedProject });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete credential', details: err.message });
    }
  });

  return router;
}

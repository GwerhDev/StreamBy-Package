import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth, ApiConnectionMethod } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { addApiConnection, deleteApiConnection } from '../../services/apiConnection';

const VALID_METHODS: ApiConnectionMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

export function apiConnectionRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // List API connections for a project
  router.get('/projects/:id/connections/api', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      return res.status(200).json({ data: project.apiConnections || [] });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch API connections', details: err.message });
    }
  });

  // Add a new API connection to a project
  router.post('/projects/:id/connections/api', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { name, baseUrl, method, description, credentialId, prefix } = req.body;

      if (!name || !baseUrl) {
        return res.status(400).json({ message: 'name and baseUrl are required' });
      }

      if (!VALID_METHODS.includes(method)) {
        return res.status(400).json({ message: `method must be one of: ${VALID_METHODS.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      if (credentialId) {
        const credExists = project.credentials?.some((c: any) => c.id === credentialId);
        if (!credExists) {
          return res.status(400).json({ message: 'Credential not found in project' });
        }
      }

      const connection = await addApiConnection(config, projectId, {
        name,
        baseUrl,
        method,
        prefix,
        ...(description !== undefined && { description }),
        ...(credentialId !== undefined && { credentialId }),
      });

      return res.status(201).json({ data: connection });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add API connection', details: err.message });
    }
  });

  // Execute the request represented by an API connection
  router.get('/projects/:id/get-connection/:connectionId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { id: projectId, connectionId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const apiConnection = project.apiConnections?.find((c: any) => c.id === connectionId);
      if (!apiConnection) {
        return res.status(404).json({ message: 'API connection not found' });
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (apiConnection.credentialId) {
        const { decrypt, isEncryptionKeySet } = await import('../../utils/encryption');
        if (!isEncryptionKeySet()) {
          return res.status(500).json({ message: 'Encryption key is not set' });
        }
        const credential = project.credentials?.find((c: any) => c.id === apiConnection.credentialId);
        if (!credential) {
          return res.status(400).json({ message: 'Credential not found in project' });
        }
        const decrypted = decrypt(credential.encryptedValue);
        const prefix = apiConnection.prefix ? `${apiConnection.prefix} ` : '';
        headers['Authorization'] = `${prefix}${decrypted}`;
      }

      const response = await fetch(apiConnection.baseUrl, { method: apiConnection.method || 'GET', headers });
      if (!response.ok) {
        return res.status(response.status).json({ message: `External API error: ${response.statusText}` });
      }

      const data = await response.json();
      return res.status(200).json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch connection data', details: err.message });
    }
  });

  // Delete an API connection from a project
  router.delete('/projects/:id/connections/api/:connectionId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { connectionId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const exists = project.apiConnections?.some((c: any) => c.id === connectionId);
      if (!exists) {
        return res.status(404).json({ message: 'API connection not found' });
      }

      await deleteApiConnection(config, projectId, connectionId);

      return res.status(200).json({ message: 'API connection deleted successfully.' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete API connection', details: err.message });
    }
  });

  return router;
}

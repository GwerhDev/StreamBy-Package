import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth, ConnectionMethod } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { addConnection, updateConnection, deleteConnection } from '../../services/connection';
import { sanitizeConnection, sanitizeConnections } from '../../utils/sanitize';

const VALID_METHODS: ConnectionMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

export function connectionRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // List connections for a project
  router.get('/projects/:id/connections', async (req: Request, res: Response) => {
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

      return res.status(200).json({ data: sanitizeConnections(project.connections) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch connections', details: err.message });
    }
  });

  // Add a new connection to a project
  router.post('/projects/:id/connections', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { name, apiUrl, method, description, token, prefix } = req.body;

      if (!name || !apiUrl) {
        return res.status(400).json({ message: 'name and apiUrl are required' });
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

      const connection = await addConnection(config, projectId, {
        name,
        apiUrl,
        method,
        prefix,
        ...(description !== undefined && { description }),
        ...(token !== undefined && { token }),
      });

      return res.status(201).json({ data: sanitizeConnection(connection) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add connection', details: err.message });
    }
  });

  // Update a connection (name, url, method, prefix, token, description)
  router.patch('/projects/:id/connections/:connectionId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const { id: projectId, connectionId } = req.params;
      const { name, apiUrl, method, description, token, prefix } = req.body;

      if (method && !VALID_METHODS.includes(method)) {
        return res.status(400).json({ message: `method must be one of: ${VALID_METHODS.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updated = await updateConnection(config, projectId, connectionId, {
        ...(name !== undefined && { name }),
        ...(apiUrl !== undefined && { apiUrl }),
        ...(method !== undefined && { method }),
        ...(description !== undefined && { description }),
        ...(prefix !== undefined && { prefix }),
        ...(token !== undefined && { token }),
      });

      return res.status(200).json({ data: sanitizeConnection(updated) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update connection', details: err.message });
    }
  });

  // Execute the request represented by a connection
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

      const connection = project.connections?.find((c: any) => c.id === connectionId);
      if (!connection) {
        return res.status(404).json({ message: 'Connection not found' });
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (connection.encryptedCredential) {
        const { decrypt, isEncryptionKeySet } = await import('../../utils/encryption');
        if (!isEncryptionKeySet()) {
          return res.status(500).json({ message: 'Encryption key is not set' });
        }
        const decrypted = decrypt(connection.encryptedCredential);
        const prefix = connection.prefix ? `${connection.prefix} ` : '';
        headers['Authorization'] = `${prefix}${decrypted}`;
      }

      const response = await fetch(connection.apiUrl, { method: connection.method || 'GET', headers });
      if (!response.ok) {
        return res.status(response.status).json({ message: `External API error: ${response.statusText}` });
      }

      const data = await response.json();
      return res.status(200).json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch connection data', details: err.message });
    }
  });

  // Delete a connection from a project
  router.delete('/projects/:id/connections/:connectionId', async (req: Request, res: Response) => {
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

      const exists = project.connections?.some((c: any) => c.id === connectionId);
      if (!exists) {
        return res.status(404).json({ message: 'Connection not found' });
      }

      await deleteConnection(config, projectId, connectionId);

      return res.status(200).json({ message: 'Connection deleted successfully.' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete connection', details: err.message });
    }
  });

  return router;
}

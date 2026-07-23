import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { StreamByConfig, Auth, StorageConnection, StorageConnectionType } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { assertBuiltinAccess } from '../../utils/builtinAccess';

const VALID_STORAGE_TYPES: StorageConnectionType[] = ['s3', 'gcs', 'r2', 'azure'];

export function storageConnectionRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // ─── List storage connections ─────────────────────────────────────────────
  router.get('/projects/:id/connections/storage', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const connections: StorageConnection[] = project.storageConnections || [];
      // Recompute availability live for builtins — never trust a stored flag, per
      // "validate on every use" (TCORE-69). BYOC (source: 'integration') is always available.
      const data = await Promise.all(connections.map(async conn => {
        if (conn.source !== 'builtin') return conn;
        const available = await assertBuiltinAccess(auth, conn.integrationId ?? conn.id, config, 'storage');
        return { ...conn, isBuiltin: true, available };
      }));

      return res.status(200).json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch storage connections', details: err.message });
    }
  });

  // ─── Add storage connection ───────────────────────────────────────────────
  router.post('/projects/:id/connections/storage', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const { name, type, credentialId, integrationId, description } = req.body;
      if (!name || !type) {
        return res.status(400).json({ message: 'name and type are required' });
      }
      if (!credentialId && !integrationId) {
        return res.status(400).json({ message: 'Either credentialId or integrationId is required' });
      }
      if (credentialId && integrationId) {
        return res.status(400).json({ message: 'Provide only one of credentialId or integrationId' });
      }
      if (!VALID_STORAGE_TYPES.includes(type)) {
        return res.status(400).json({ message: `type must be one of: ${VALID_STORAGE_TYPES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      if (integrationId) {
        const UserIntegrationModel = getModel('user_integrations');
        const integration = await UserIntegrationModel.findOne({ id: integrationId, userId: auth.userId });
        if (!integration) return res.status(404).json({ message: 'Integration not found' });
        if (integration.kind !== 'storage') return res.status(400).json({ message: 'Integration is not a storage integration' });
      } else {
        const credExists = project.credentials?.some((c: any) => c.id === credentialId);
        if (!credExists) return res.status(400).json({ message: 'Credential not found in project' });
      }

      const connection: StorageConnection = {
        id: new ObjectId().toHexString(),
        name,
        type,
        credentialId: credentialId ?? '',
        projectId: req.params.id,
        createdAt: new Date(),
        source: integrationId ? 'integration' : 'manual',
        ...(integrationId && { integrationId }),
        ...(description !== undefined && { description }),
      };

      await Project.update({ _id: req.params.id }, { $push: { storageConnections: connection } });
      return res.status(201).json({ data: connection });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add storage connection', details: err.message });
    }
  });

  // ─── Delete storage connection ────────────────────────────────────────────
  router.delete('/projects/:id/connections/storage/:connId', async (req: Request, res: Response) => {
    try {
      const { connId } = req.params;
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const conn = project.storageConnections?.find((c: StorageConnection) => c.id === connId);
      if (!conn) return res.status(404).json({ message: 'Storage connection not found' });
      if (conn.source === 'builtin') {
        return res.status(403).json({ message: 'Cannot delete a built-in storage connection' });
      }

      await Project.update({ _id: req.params.id }, { $pull: { storageConnections: { id: connId } } });
      return res.status(200).json({ message: 'Storage connection deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete storage connection', details: err.message });
    }
  });

  return router;
}

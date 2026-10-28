import { Router, Request, Response } from 'express';
import { addToWorkflow, removeFromWorkflow } from '../../services/workflowResources';
import { ObjectId } from 'mongodb';
import { StreamByConfig, Auth, StorageConnection, StorageConnectionType } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { assertBuiltinAccess } from '../../utils/builtinAccess';
import { sanitizeConnection } from '../../utils/sanitize';
import { encrypt, isEncryptionKeySet } from '../../utils/encryption';
import { rememberDisconnectedBuiltin } from './projectResources';
import { connectIntegration } from '../../services/projectIntegration';

const VALID_STORAGE_TYPES: StorageConnectionType[] = ['s3', 'gcs', 'r2', 'azure'];

export function storageConnectionRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // The project's storage connections as they're answered, by the list and after each change.
  // Availability is recomputed live for builtins — never trust a stored flag, per "validate on
  // every use" (TCORE-69). BYOC (source: 'integration') is always available.
  const listOf = (project: any, auth: Auth) => Promise.all(((project.storageConnections || []) as StorageConnection[]).map(async conn => {
    if (conn.source !== 'builtin') return sanitizeConnection(conn);
    const available = await assertBuiltinAccess(auth, conn.integrationId ?? conn.id, config, 'storage');
    return sanitizeConnection({ ...conn, isBuiltin: true, available });
  }));
  const listNow = async (projectId: string, auth: Auth) => listOf(await Project.findOne({ _id: projectId }), auth);

  // ─── List storage connections ─────────────────────────────────────────────
  router.get('/projects/:id/connections/storage', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      return res.status(200).json({ data: await listOf(project, auth) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch storage connections', details: err.message });
    }
  });

  // ─── Add storage connection ───────────────────────────────────────────────
  router.post('/projects/:id/connections/storage', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const { name, type, credential, integrationId, description } = req.body;
      if (credential && integrationId) {
        return res.status(400).json({ message: 'Provide only one of credential or integrationId' });
      }
      // An integration (the user's, or a built-in) is a named, typed storage already.
      if (integrationId) {
        const project = await Project.findOne({ _id: req.params.id });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });
        const result = await connectIntegration(project, integrationId, auth, config, { kind: 'storage', description });
        if ('error' in result) return res.status(result.status).json({ message: result.error });
        await addToWorkflow(req.params.id, 'storage', result.connection);
        return res.status(201).json({ data: sanitizeConnection(result.connection as StorageConnection), storageConnections: await listNow(req.params.id, auth) });
      }
      if (!name || !type) {
        return res.status(400).json({ message: 'name and type are required' });
      }
      if (!credential && !integrationId) {
        return res.status(400).json({ message: 'Either credential or integrationId is required' });
      }
      if (credential && integrationId) {
        return res.status(400).json({ message: 'Provide only one of credential or integrationId' });
      }
      if (!VALID_STORAGE_TYPES.includes(type)) {
        return res.status(400).json({ message: `type must be one of: ${VALID_STORAGE_TYPES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      let encryptedCredential: string | undefined;
      if (integrationId) {
        const UserIntegrationModel = getModel('user_integrations');
        const integration = await UserIntegrationModel.findOne({ id: integrationId, userId: auth.userId });
        if (!integration) return res.status(404).json({ message: 'Integration not found' });
        if (integration.kind !== 'storage') return res.status(400).json({ message: 'Integration is not a storage integration' });
      } else {
        if (!isEncryptionKeySet()) return res.status(500).json({ message: 'Encryption key is not set' });
        encryptedCredential = encrypt(credential);
      }

      const connection: StorageConnection = {
        id: new ObjectId().toHexString(),
        name,
        type,
        projectId: req.params.id,
        createdAt: new Date(),
        source: integrationId ? 'integration' : 'manual',
        ...(integrationId && { integrationId }),
        ...(encryptedCredential !== undefined && { encryptedCredential }),
        ...(description !== undefined && { description }),
      };

      await Project.update({ _id: req.params.id }, { $push: { storageConnections: connection } });
      await addToWorkflow(req.params.id, 'storage', connection);
      return res.status(201).json({ data: sanitizeConnection(connection), storageConnections: await listNow(req.params.id, auth) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add storage connection', details: err.message });
    }
  });

  // ─── Delete storage connection ────────────────────────────────────────────
  router.delete('/projects/:id/connections/storage/:connId', async (req: Request, res: Response) => {
    try {
      const { connId } = req.params;
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const conn = project.storageConnections?.find((c: StorageConnection) => c.id === connId);
      if (!conn) return res.status(404).json({ message: 'Storage connection not found' });
      // A built-in is disconnected, not deleted: its files stay in it, and it can be connected
      // again with them (routes/projectResources).
      await Project.update({ _id: req.params.id }, { $pull: { storageConnections: { id: connId } } });
      if (conn.source === 'builtin') await rememberDisconnectedBuiltin(req.params.id, 'storage', conn);
      await removeFromWorkflow(req.params.id, 'storage', connId);
      return res.status(200).json({ message: 'Storage connection deleted successfully', storageConnections: await listNow(req.params.id, auth) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete storage connection', details: err.message });
    }
  });

  return router;
}

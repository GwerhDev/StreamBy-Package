import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { StreamByConfig, Auth, StorageConnection, StorageConnectionType } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';

const VALID_STORAGE_TYPES: StorageConnectionType[] = ['s3', 'gcs', 'r2', 'azure'];

const STORAGE_DISPLAY: Record<StorageConnectionType, string> = {
  s3:    'AWS S3',
  gcs:   'Google Cloud Storage',
  r2:    'Cloudflare R2',
  azure: 'Azure Blob Storage',
};

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

      const builtinConnections: StorageConnection[] = (config.storageProviders || []).map((provider, i) => ({
        id: i === 0 ? 'builtin' : `builtin-${i}`,
        name: STORAGE_DISPLAY[provider.type] || provider.type,
        type: provider.type,
        credentialId: '',
        projectId: req.params.id,
        createdAt: new Date(0),
        isBuiltin: true,
      }));

      const projectConnections: StorageConnection[] = project.storageConnections || [];
      return res.status(200).json({ data: [...builtinConnections, ...projectConnections] });
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

      const { name, type, credentialId, description } = req.body;
      if (!name || !type || !credentialId) {
        return res.status(400).json({ message: 'name, type, and credentialId are required' });
      }
      if (!VALID_STORAGE_TYPES.includes(type)) {
        return res.status(400).json({ message: `type must be one of: ${VALID_STORAGE_TYPES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const credExists = project.credentials?.some((c: any) => c.id === credentialId);
      if (!credExists) return res.status(400).json({ message: 'Credential not found in project' });

      const connection: StorageConnection = {
        id: new ObjectId().toHexString(),
        name,
        type,
        credentialId,
        projectId: req.params.id,
        createdAt: new Date(),
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
      if (connId === 'builtin' || connId.startsWith('builtin-')) {
        return res.status(403).json({ message: 'Cannot delete a built-in storage connection' });
      }

      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const exists = project.storageConnections?.some((c: any) => c.id === connId);
      if (!exists) return res.status(404).json({ message: 'Storage connection not found' });

      await Project.update({ _id: req.params.id }, { $pull: { storageConnections: { id: connId } } });
      return res.status(200).json({ message: 'Storage connection deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete storage connection', details: err.message });
    }
  });

  return router;
}

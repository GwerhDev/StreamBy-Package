import { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter, Auth, StorageConnection } from '../../types';
import { deleteProjectImage } from '../../services/file';
import { getPresignedProjectImageUrl } from '../../services/presign';
import { createStorageProvider } from '../../providers/storage';
import { S3Adapter } from '../../adapters/storage/s3';
import { getModel } from '../../models/manager';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { isProjectMember } from '../../utils/auth';
import { decrypt, isEncryptionKeySet } from '../../utils/encryption';
import { assertBuiltinAccess, isBuiltinStorageId } from '../../utils/builtinAccess';
import { getDecryptedIntegrationCredentialById } from '../../services/userIntegration';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'crypto';

type StorageCategory = 'images' | 'audios' | 'videos' | '3d-models';

const VALID_CATEGORIES: StorageCategory[] = ['images', 'audios', 'videos', '3d-models'];
const VALID_3D_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);

function validateContentType(contentType: string, filename: string, category: StorageCategory): boolean {
  if (category === 'images') return contentType.startsWith('image/');
  if (category === 'audios') return contentType.startsWith('audio/');
  if (category === 'videos') return contentType.startsWith('video/');
  if (category === '3d-models') {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ext ? VALID_3D_EXTENSIONS.has(`.${ext}`) : false;
  }
  return false;
}

function getRawFilesCollection() {
  const model = getModel('storage_files', 'nosql') as any;
  const connectionIds: string[] = model.getConnectionIds();
  const activeId = connectionIds.find((id: string) =>
    getConnectedIds().includes(id) && getConnection(id).type === 'nosql',
  );
  if (!activeId) return null;
  return (getConnection(activeId).client as MongoClient).db().collection('storage_files');
}

function getRawFoldersCollection() {
  const model = getModel('storage_files', 'nosql') as any;
  const connectionIds: string[] = model.getConnectionIds();
  const activeId = connectionIds.find((id: string) =>
    getConnectedIds().includes(id) && getConnection(id).type === 'nosql',
  );
  if (!activeId) return null;
  return (getConnection(activeId).client as MongoClient).db().collection('storage_folders');
}

export function storageRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);
  const Project = getModel('projects');

  function connFilter(projectId: string, connId: string, extra?: Record<string, any>) {
    const isBuiltin = isBuiltinStorageId(connId, config);
    const connMatch = isBuiltin
      ? { $or: [{ storageConnectionId: connId }, { storageConnectionId: { $exists: false } }] }
      : { storageConnectionId: connId };
    return { projectId, ...connMatch, ...(extra ?? {}) };
  }

  async function resolveConnAdapter(
    connId: string,
    project: any,
    auth: Auth,
  ): Promise<StorageAdapter | { error: string; status: number }> {
    if (isBuiltinStorageId(connId, config)) {
      if (!(await assertBuiltinAccess(auth, connId, config, 'storage'))) {
        return { error: 'Access to this built-in storage is not permitted', status: 403 };
      }
      const provider = config.storageProviders.find(p => p.id === connId);
      if (!provider) return { error: 'Storage provider not found', status: 404 };
      return provider.type === 's3' ? new S3Adapter(provider.config) : adapter;
    }

    const conn: StorageConnection | undefined = project.storageConnections?.find((c: StorageConnection) => c.id === connId);
    if (!conn) return { error: 'Storage connection not found', status: 404 };

    if (conn.source === 'integration') {
      if (!conn.integrationId) return { error: 'Connection is missing its integrationId', status: 500 };
      try {
        const s3Config = await getDecryptedIntegrationCredentialById(conn.integrationId);
        if (!s3Config) return { error: 'Integration not found', status: 400 };
        return new S3Adapter(s3Config as any);
      } catch (e: any) {
        return { error: `Failed to initialize storage adapter: ${e.message}`, status: 500 };
      }
    }

    if (!isEncryptionKeySet()) return { error: 'Encryption key not set', status: 500 };

    const credential = project.credentials?.find((c: any) => c.id === conn.credentialId);
    if (!credential) return { error: 'Credential not found in project', status: 400 };

    try {
      const s3Config = JSON.parse(decrypt(credential.encryptedValue));
      return new S3Adapter(s3Config);
    } catch (e: any) {
      return { error: `Failed to initialize storage adapter: ${e.message}`, status: 500 };
    }
  }

  router.get('/upload-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') return res.status(403).json({ message: 'Permission denied' });

      const projectId = req.params.id;
      if (!projectId) return res.status(400).json({ message: 'Missing projectId' });

      const response = await getPresignedProjectImageUrl(adapter, projectId);
      res.status(200).json({ ...response, message: 'Presigned URL generated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate presigned URL', details: err.message });
    }
  });

  router.delete('/delete-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') return res.status(403).json({ message: 'Permission denied' });

      const projectId = req.params.id;
      if (!projectId) return res.status(400).json({ message: 'Missing projectId' });

      await deleteProjectImage(adapter, projectId);
      const updated = await Project.update({ _id: projectId }, { image: '' });
      res.status(201).json({ ...updated, message: 'Image deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete image', details: err.message });
    }
  });

  router.get('/projects/:projectId/storage/:category/upload-url', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, category } = req.params;
      const { fileName, contentType } = req.query as { fileName?: string; contentType?: string };

      if (!VALID_CATEGORIES.includes(category as StorageCategory)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      if (!fileName || !contentType) {
        return res.status(400).json({ message: 'Query params fileName and contentType are required' });
      }
      if (!validateContentType(contentType, fileName, category as StorageCategory)) {
        const hint = category === '3d-models'
          ? '.glb, .gltf, .obj, .fbx, .stl, or .ply'
          : `${category.slice(0, -1)}/* content type`;
        return res.status(400).json({ message: `Files in the ${category} category must match ${hint}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      if (!adapter.getPresignedUploadUrl) {
        return res.status(501).json({ message: 'Storage adapter does not support presigned uploads' });
      }

      const ext = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
      const fileId = crypto.randomUUID();
      const storageKey = `${projectId}/${category}/${fileId}${ext}`;

      const collection = getRawFilesCollection();
      if (collection) {
        await collection.insertOne({
          _id: new ObjectId(),
          fileId,
          projectId,
          category,
          storageKey,
          displayName: fileName,
          contentType,
          uploadedBy: auth.userId,
          createdAt: new Date(),
        });
      }

      const url = await adapter.getPresignedUploadUrl(storageKey, contentType);
      res.json({ url, fileId, storageKey, displayName: fileName });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate upload URL', details: err.message });
    }
  });

  router.get('/projects/:projectId/storage/files/:fileId/replace-url', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;
      const { contentType, fileName } = req.query as { contentType?: string; fileName?: string };

      if (!contentType || !fileName) {
        return res.status(400).json({ message: 'Query params contentType and fileName are required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const fileDoc = await collection.findOne({ fileId, projectId });
      if (!fileDoc) return res.status(404).json({ message: 'File not found' });

      if (!validateContentType(contentType, fileName, fileDoc.category as StorageCategory)) {
        return res.status(400).json({ message: `File does not match category ${fileDoc.category}` });
      }

      if (!adapter.getPresignedUploadUrl) {
        return res.status(501).json({ message: 'Storage adapter does not support presigned uploads' });
      }

      const url = await adapter.getPresignedUploadUrl(fileDoc.storageKey, contentType);
      await collection.updateOne({ fileId, projectId }, { $set: { contentType, updatedAt: new Date() } });

      res.json({ url, storageKey: fileDoc.storageKey, fileId });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate replace URL', details: err.message });
    }
  });

  router.patch('/projects/:projectId/storage/files/:fileId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;
      const { displayName } = req.body;

      if (!displayName || typeof displayName !== 'string') {
        return res.status(400).json({ message: 'displayName is required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const result = await collection.findOneAndUpdate(
        { fileId, projectId },
        { $set: { displayName } },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'File not found' });
      res.json({ message: 'File renamed successfully', file: result });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to rename file', details: err.message });
    }
  });

  router.delete('/projects/:projectId/storage/files/:fileId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const fileDoc = await collection.findOne({ fileId, projectId });
      if (!fileDoc) return res.status(404).json({ message: 'File not found' });

      if (adapter.deleteFile) await adapter.deleteFile(fileDoc.storageKey);
      await collection.deleteOne({ fileId, projectId });

      res.json({ message: 'File deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete file', details: err.message });
    }
  });

  router.get('/projects/:projectId/storage/lasts', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const files = await collection.find({ projectId }).sort({ createdAt: -1 }).limit(12).toArray();
      const data = await Promise.all(files.map(f => resolveFileUrl(f, adapter)));
      res.json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch latest files', details: err.message });
    }
  });

  router.get('/projects/:projectId/storage/:category', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, category } = req.params;

      if (!VALID_CATEGORIES.includes(category as StorageCategory)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const files = await collection.find({ projectId, category }).sort({ createdAt: -1 }).toArray();
      const data = await Promise.all(files.map(f => resolveFileUrl(f, adapter)));
      res.json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list files', details: err.message });
    }
  });

  // ─── Per-connection file routes ───────────────────────────────────────────

  router.get('/projects/:projectId/connections/storage/:connId/upload-url', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId } = req.params;
      const { fileName, contentType, category } = req.query as { fileName?: string; contentType?: string; category?: string };

      if (!category || !VALID_CATEGORIES.includes(category as StorageCategory)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      if (!fileName || !contentType) {
        return res.status(400).json({ message: 'Query params fileName and contentType are required' });
      }
      if (!validateContentType(contentType, fileName, category as StorageCategory)) {
        return res.status(400).json({ message: `File does not match category ${category}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const connAdapter = await resolveConnAdapter(connId, project, auth);
      if ('error' in connAdapter) return res.status(connAdapter.status).json({ message: connAdapter.error });
      if (!connAdapter.getPresignedUploadUrl) return res.status(501).json({ message: 'Storage adapter does not support presigned uploads' });

      const ext = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
      const fileId = crypto.randomUUID();
      const storageKey = `${projectId}/${category}/${fileId}${ext}`;

      const collection = getRawFilesCollection();
      if (collection) {
        await collection.insertOne({
          _id: new ObjectId(),
          fileId,
          projectId,
          storageConnectionId: connId,
          category,
          storageKey,
          displayName: fileName,
          contentType,
          uploadedBy: auth.userId,
          createdAt: new Date(),
        });
      }

      const url = await connAdapter.getPresignedUploadUrl(storageKey, contentType);
      res.json({ url, fileId, storageKey, displayName: fileName });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate upload URL', details: err.message });
    }
  });

  router.get('/projects/:projectId/connections/storage/:connId/files/lasts', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const connAdapter = await resolveConnAdapter(connId, project, auth);
      if ('error' in connAdapter) return res.status(connAdapter.status).json({ message: connAdapter.error });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const files = await collection.find(connFilter(projectId, connId)).sort({ createdAt: -1 }).limit(12).toArray();
      const data = await Promise.all(files.map(f => resolveFileUrl(f, connAdapter)));
      res.json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch latest files', details: err.message });
    }
  });

  router.get('/projects/:projectId/connections/storage/:connId/files/:category', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, category } = req.params;

      if (!VALID_CATEGORIES.includes(category as StorageCategory)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const connAdapter = await resolveConnAdapter(connId, project, auth);
      if ('error' in connAdapter) return res.status(connAdapter.status).json({ message: connAdapter.error });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const files = await collection.find(connFilter(projectId, connId, { category })).sort({ createdAt: -1 }).toArray();
      const data = await Promise.all(files.map(f => resolveFileUrl(f, connAdapter)));
      res.json({ data });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list files', details: err.message });
    }
  });

  router.get('/projects/:projectId/connections/storage/:connId/files/:fileId/replace-url', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, fileId } = req.params;
      const { contentType, fileName } = req.query as { contentType?: string; fileName?: string };

      if (!contentType || !fileName) {
        return res.status(400).json({ message: 'Query params contentType and fileName are required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const fileDoc = await collection.findOne(connFilter(projectId, connId, { fileId }));
      if (!fileDoc) return res.status(404).json({ message: 'File not found' });

      if (!validateContentType(contentType, fileName, fileDoc.category as StorageCategory)) {
        return res.status(400).json({ message: `File does not match category ${fileDoc.category}` });
      }

      const connAdapter = await resolveConnAdapter(connId, project, auth);
      if ('error' in connAdapter) return res.status(connAdapter.status).json({ message: connAdapter.error });
      if (!connAdapter.getPresignedUploadUrl) {
        return res.status(501).json({ message: 'Storage adapter does not support presigned uploads' });
      }

      const url = await connAdapter.getPresignedUploadUrl(fileDoc.storageKey, contentType);
      await collection.updateOne(
        connFilter(projectId, connId, { fileId }),
        { $set: { contentType, updatedAt: new Date() } },
      );

      res.json({ url, storageKey: fileDoc.storageKey, fileId });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate replace URL', details: err.message });
    }
  });

  router.patch('/projects/:projectId/connections/storage/:connId/files/:fileId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, fileId } = req.params;
      const { displayName } = req.body;

      if (!displayName || typeof displayName !== 'string') {
        return res.status(400).json({ message: 'displayName is required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const result = await collection.findOneAndUpdate(
        connFilter(projectId, connId, { fileId }),
        { $set: { displayName } },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'File not found' });
      res.json({ message: 'File renamed successfully', file: result });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to rename file', details: err.message });
    }
  });

  router.delete('/projects/:projectId/connections/storage/:connId/files/:fileId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, fileId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const connAdapter = await resolveConnAdapter(connId, project, auth);
      if ('error' in connAdapter) return res.status(connAdapter.status).json({ message: connAdapter.error });

      const collection = getRawFilesCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const fileDoc = await collection.findOne(connFilter(projectId, connId, { fileId }));
      if (!fileDoc) return res.status(404).json({ message: 'File not found' });

      if (connAdapter.deleteFile) await connAdapter.deleteFile(fileDoc.storageKey);
      await collection.deleteOne(connFilter(projectId, connId, { fileId }));

      res.json({ message: 'File deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete file', details: err.message });
    }
  });

  // ─── Folder routes (per-connection) ─────────────────────────────────────

  router.get('/projects/:projectId/connections/storage/:connId/folders', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId } = req.params;
      const { parentId } = req.query as { parentId?: string };

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFoldersCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const parentFilter = (parentId === undefined || parentId === 'null')
        ? { parentId: null }
        : { parentId };

      const folders = await collection
        .find(connFilter(projectId, connId, parentFilter))
        .sort({ name: 1 })
        .toArray();

      res.json({
        data: folders.map(f => ({
          id: f.folderId,
          name: f.name,
          parentId: f.parentId ?? null,
          projectId: f.projectId,
          storageConnectionId: f.storageConnectionId,
          createdBy: f.createdBy,
          createdAt: f.createdAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list folders', details: err.message });
    }
  });

  router.get('/projects/:projectId/connections/storage/:connId/folders/:folderId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, folderId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFoldersCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const f = await collection.findOne(connFilter(projectId, connId, { folderId }));
      if (!f) return res.status(404).json({ message: 'Folder not found' });

      res.json({
        folder: {
          id: f.folderId,
          name: f.name,
          parentId: f.parentId ?? null,
          projectId: f.projectId,
          storageConnectionId: f.storageConnectionId,
          createdBy: f.createdBy,
          createdAt: f.createdAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to get folder', details: err.message });
    }
  });

  router.post('/projects/:projectId/connections/storage/:connId/folders', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId } = req.params;
      const { name, parentId } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ message: 'Folder name is required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const isBuiltin = isBuiltinStorageId(connId, config);
      if (isBuiltin && !(await assertBuiltinAccess(auth, connId, config, 'storage'))) {
        return res.status(403).json({ message: 'Access to this built-in storage is not permitted' });
      }

      const collection = getRawFoldersCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const folderId = crypto.randomUUID();
      const folderDoc: Record<string, any> = {
        _id: new ObjectId(),
        folderId,
        projectId,
        name: name.trim(),
        parentId: parentId ?? null,
        createdBy: auth.userId,
        createdAt: new Date(),
      };
      if (!isBuiltin) folderDoc.storageConnectionId = connId;

      await collection.insertOne(folderDoc);

      res.status(201).json({
        message: 'Folder created successfully',
        folder: {
          id: folderId,
          name: folderDoc.name,
          parentId: folderDoc.parentId,
          projectId,
          storageConnectionId: isBuiltin ? undefined : connId,
          createdBy: auth.userId,
          createdAt: folderDoc.createdAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create folder', details: err.message });
    }
  });

  router.patch('/projects/:projectId/connections/storage/:connId/folders/:folderId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, folderId } = req.params;
      const { name } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ message: 'Folder name is required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFoldersCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const result = await collection.findOneAndUpdate(
        connFilter(projectId, connId, { folderId }),
        { $set: { name: name.trim(), updatedAt: new Date() } },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Folder not found' });

      res.json({
        message: 'Folder renamed successfully',
        folder: {
          id: result.folderId,
          name: result.name,
          parentId: result.parentId ?? null,
          projectId: result.projectId,
          createdAt: result.createdAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to rename folder', details: err.message });
    }
  });

  router.patch('/projects/:projectId/connections/storage/:connId/folders/:folderId/move', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, folderId } = req.params;
      const { newParentId } = req.body as { newParentId?: string | null };

      if (newParentId === folderId) {
        return res.status(400).json({ message: 'A folder cannot be its own parent' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const collection = getRawFoldersCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const result = await collection.findOneAndUpdate(
        connFilter(projectId, connId, { folderId }),
        { $set: { parentId: newParentId ?? null, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Folder not found' });

      res.json({
        message: 'Folder moved successfully',
        folder: {
          id: result.folderId,
          name: result.name,
          parentId: result.parentId ?? null,
          projectId: result.projectId,
          createdAt: result.createdAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to move folder', details: err.message });
    }
  });

  router.delete('/projects/:projectId/connections/storage/:connId/folders/:folderId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, folderId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const foldersCollection = getRawFoldersCollection();
      if (!foldersCollection) return res.status(500).json({ message: 'Database not available' });

      const folderDoc = await foldersCollection.findOne(connFilter(projectId, connId, { folderId }));
      if (!folderDoc) return res.status(404).json({ message: 'Folder not found' });

      const filesCollection = getRawFilesCollection();
      if (filesCollection) {
        await filesCollection.updateMany(
          connFilter(projectId, connId, { folderId }),
          { $set: { folderId: folderDoc.parentId ?? null } },
        );
      }

      await foldersCollection.updateMany(
        connFilter(projectId, connId, { parentId: folderId }),
        { $set: { parentId: folderDoc.parentId ?? null } },
      );

      await foldersCollection.deleteOne(connFilter(projectId, connId, { folderId }));

      res.json({ message: 'Folder deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete folder', details: err.message });
    }
  });

  router.patch('/projects/:projectId/connections/storage/:connId/files/:fileId/move', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connId, fileId } = req.params;
      const { folderId } = req.body;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      if (folderId != null) {
        const foldersCollection = getRawFoldersCollection();
        if (foldersCollection) {
          const folderDoc = await foldersCollection.findOne(connFilter(projectId, connId, { folderId }));
          if (!folderDoc) return res.status(404).json({ message: 'Folder not found' });
        }
      }

      const filesCollection = getRawFilesCollection();
      if (!filesCollection) return res.status(500).json({ message: 'Database not available' });

      const result = await filesCollection.findOneAndUpdate(
        connFilter(projectId, connId, { fileId }),
        { $set: { folderId: folderId ?? null } },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'File not found' });
      res.json({ message: 'File moved successfully', file: result });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to move file', details: err.message });
    }
  });

  router.get('/storages', async (_req: Request, res: Response) => {
    try {
      const STORAGE_DISPLAY: Record<string, { value: string; name: string }> = {
        s3:    { value: 'aws-s3',               name: 'AWS S3' },
        gcs:   { value: 'google-cloud-storage', name: 'Google Cloud Storage' },
        azure: { value: 'azure-blob',           name: 'Azure Blob Storage' },
        r2:    { value: 'cloudflare-r2',        name: 'Cloudflare R2' },
      };

      const storages = (config.storageProviders || []).map(provider => ({
        id: provider.id,
        ...STORAGE_DISPLAY[provider.type],
        type: provider.type,
      }));

      res.status(200).json({ storages });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

async function resolveFileUrl(file: any, adapter: StorageAdapter): Promise<any> {
  let url: string | null = null;
  if (adapter.getPresignedGetUrl) {
    try { url = await adapter.getPresignedGetUrl(file.storageKey); } catch { /* leave null */ }
  }
  return {
    id: file.fileId,
    displayName: file.displayName,
    storageKey: file.storageKey,
    category: file.category,
    contentType: file.contentType,
    uploadedBy: file.uploadedBy,
    createdAt: file.createdAt,
    folderId: file.folderId ?? null,
    url,
  };
}

import { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter, Auth } from '../../types';
import { deleteProjectImage } from '../../services/file';
import { getPresignedProjectImageUrl } from '../../services/presign';
import { createStorageProvider } from '../../providers/storage';
import { getModel } from '../../models/manager';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { isProjectMember } from '../../utils/auth';
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

export function storageRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);
  const Project = getModel('projects');

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

  router.get('/storages', async (_req: Request, res: Response) => {
    try {
      const STORAGE_DISPLAY: Record<string, { value: string; name: string }> = {
        s3:    { value: 'aws-s3',               name: 'AWS S3' },
        gcs:   { value: 'google-cloud-storage', name: 'Google Cloud Storage' },
        azure: { value: 'azure-blob',           name: 'Azure Blob Storage' },
        r2:    { value: 'cloudflare-r2',        name: 'Cloudflare R2' },
      };

      const storages = (config.storageProviders || []).map(provider => ({
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
    url,
  };
}

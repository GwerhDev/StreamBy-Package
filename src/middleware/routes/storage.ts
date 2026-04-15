import { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../../types';
import { deleteProjectImage } from '../../services/file';
import { getPresignedProjectImageUrl } from '../../services/presign';
import { createStorageProvider } from '../../providers/storage';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';

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

function sanitizeFilename(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const ext = dotIndex !== -1 ? filename.slice(dotIndex) : '';
  const base = (dotIndex !== -1 ? filename.slice(0, dotIndex) : filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${base}${ext}`;
}

export function storageRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);
  const Project = getModel('projects');

  router.get('/upload-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ message: 'Missing projectId' });
      }

      const response = await getPresignedProjectImageUrl(adapter, projectId);

      res.status(200).json({ ...response, message: 'Presigned URL generated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate presigned URL', details: err.message });
    }
  });

  router.delete('/delete-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ message: 'Missing projectId' });
      }

      await deleteProjectImage(adapter, projectId);
      const updated = await Project.update({ _id: projectId }, { image: '' });

      res.status(201).json({ ...updated, message: 'Image deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete image', details: err.message });
    }
  });

  router.get('/projects/:projectId/storage/:category/upload-url', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth || !auth.userId || !auth.role) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

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
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized access' });
      }

      if (!adapter.getPresignedUploadUrl) {
        return res.status(501).json({ message: 'Storage adapter does not support presigned uploads' });
      }

      const key = `${projectId}/${category}/${sanitizeFilename(fileName)}`;
      const url = await adapter.getPresignedUploadUrl(key, contentType);

      res.json({ url });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to generate upload URL', details: err.message });
    }
  });

  router.get('/projects/:projectId/storage/:category', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth || !auth.userId || !auth.role) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { projectId, category } = req.params;

      if (!VALID_CATEGORIES.includes(category as StorageCategory)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized access' });
      }

      if (!adapter.listFilesByCategory) {
        return res.status(501).json({ message: 'Storage adapter does not support listing files by category' });
      }

      const files = await adapter.listFilesByCategory(projectId, category);
      res.json({ data: files });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list files', details: err.message });
    }
  });

  router.delete('/projects/:projectId/storage/:category/:key', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth || !auth.userId || !auth.role) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { projectId, category } = req.params;
      const key = decodeURIComponent(req.params.key);

      if (!VALID_CATEGORIES.includes(category as StorageCategory)) {
        return res.status(400).json({ message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized access' });
      }

      if (!adapter.deleteFile) {
        return res.status(501).json({ message: 'Storage adapter does not support file deletion' });
      }

      await adapter.deleteFile(key);
      res.json({ message: 'File deleted successfully.' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete file', details: err.message });
    }
  });

  router.get('/storages', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth || !auth.userId || !auth.role) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const STORAGE_DISPLAY: Record<string, { value: string; name: string }> = {
        s3:    { value: 'aws-s3',              name: 'AWS S3' },
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

import express, { Router, Request, Response } from 'express';
import { ProjectProvider, StreamByConfig, StorageAdapter } from '../types';
import { deleteProjectImage, listFilesService } from '../services/file';
import { getPresignedProjectImageUrl } from '../services/presign';
import { createStorageProvider } from '../providers/createStorageProvider';
import { createDatabaseProvider } from '../providers/createDatabaseProvider';

function isProjectMember(project: any, userId: string) {
  return project.members?.some((m: any) => m.userId?.toString() === userId?.toString());
}

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);

  const projectProviders: Record<string, ProjectProvider | undefined> = {};
  let exportProvider: any;
  let exportCollectionProvider: any;

  if (config.databases) {
    const db = createDatabaseProvider(config.databases, adapter);
        projectProviders.nosql = db.projectProviders.nosql;
    projectProviders.sql = db.projectProviders.sql;
    exportProvider = db.exportProvider;
    exportCollectionProvider = db.exportCollectionProvider;
  } else {
    projectProviders.default = config.projectProvider;
    exportProvider = config.exportProvider;
    exportCollectionProvider = config.exportCollectionProvider;
  }

  if (!projectProviders.nosql && !projectProviders.sql) {
    throw new Error('Project provider is not initialized. Please check your database configuration.');
  }

  if (!exportProvider) {
    throw new Error('Export provider is not initialized. Please check your database configuration.');
  }

  router.get('/auth', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      res.status(200).json({ logged: true, ...auth });
    } catch (err) {
      res.status(401).json({ logged: false });
    }
  });

  router.get('/databases', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const databases = [];
      if (projectProviders.nosql) {
        databases.push({ name: "NoSQL (Mongo)", value: "nosql" });
      }
      if (projectProviders.sql) {
        databases.push({ name: "SQL (Prisma)", value: "sql" });
      }
      res.status(200).json({ databases });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get databases' });
    }
  });

  router.get('/upload-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }

      const url = await getPresignedProjectImageUrl(adapter, projectId);
      res.json(url);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate presigned URL', details: err.message });
    }
  });

  router.delete('/delete-project-image-url/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }

      await deleteProjectImage(adapter, projectId);
      const provider = await getProjectProvider(projectId);
      if (!provider) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const updated = await provider.update(projectId, { image: '' });

      res.status(201).json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete image', details: err.message });
    }
  });

  router.get('/files', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = (req.query.projectId || req.headers['x-project-id']) as string;

      if (!projectId || !auth.projects.includes(projectId)) {
        return res.status(403).json({ error: 'Unauthorized or missing projectId' });
      }

      const files = await listFilesService(adapter, req, projectId);
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list files', details: err });
    }
  });

  async function getProjectProvider(projectId: string, dbType?: string): Promise<ProjectProvider | null> {
    if (dbType) {
      const specificProvider = projectProviders[dbType];
      if (specificProvider) {
        try {
          const project = await specificProvider.getById(projectId, true);
          if (project) return specificProvider;
        } catch (error) { /* ignore */ }
      }
      return null; // If dbType was provided and no project found in that specific provider, return null.
    }

    // If dbType is not provided, search both nosql and sql
    if (projectProviders.nosql) {
      try {
        const project = await projectProviders.nosql.getById(projectId, true);
        if (project) return projectProviders.nosql;
      } catch (error) { /* ignore */ }
    }

    if (projectProviders.sql) {
      try {
        const project = await projectProviders.sql.getById(projectId, true);
        if (project) return projectProviders.sql;
      } catch (error) { /* ignore */ }
    }

    return null; // If not found in either nosql or sql, return null.
  }

  router.get('/projects', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const archived = req.query.archived ? String(req.query.archived).toLowerCase() === 'true' : undefined;
      
      const projects = [];
      if (projectProviders.nosql) {
        projects.push(...await projectProviders.nosql.list(auth.userId, archived));
      }
      if (projectProviders.sql) {
        projects.push(...await projectProviders.sql.list(auth.userId, archived));
      }
      if (projectProviders.default) {
        projects.push(...await projectProviders.default.list(auth.userId, archived));
      }
      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list projects', details: err });
    }
  });

  router.post('/projects/create', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);

      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const { name, description, dbType } = req.body;

      const provider = dbType ? projectProviders[dbType] : projectProviders.default || projectProviders.nosql || projectProviders.sql;

      if (!provider) {
        return res.status(400).json({ error: 'Invalid dbType' });
      }

      const newProject = await provider.create({
        dbType: dbType || 'nosql',
        name,
        description: description || '',
        members: [{ userId: auth.userId, role: "admin" }]
      });

      res.status(201).json({ project: newProject });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create project', details: err.message });
    }
  });

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;
      const dbType = req.query.dbType as string | undefined;

      const projectProvider = await getProjectProvider(projectId, dbType);
      

      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      res.json({ project });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project', details: err.message });
    }
  });

  router.patch('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      const updates = req.body;

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Missing updates payload' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const updated = await projectProvider.update(projectId, updates);
      res.status(200).json({ success: true, project: updated });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update project', details: err.message });
    }
  });

  router.delete('/projects/:id', async (req, res) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await projectProvider.delete(projectId);

      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete project', details: err.message });
    }
  });

  router.patch('/projects/:id/archive', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await projectProvider.archive(projectId, auth.userId);
      const projects = [];
      if (projectProviders.nosql) {
        projects.push(...await projectProviders.nosql.list(auth.userId));
      }
      if (projectProviders.sql) {
        projects.push(...await projectProviders.sql.list(auth.userId));
      }
      if (projectProviders.default) {
        projects.push(...await projectProviders.default.list(auth.userId));
      }
      res.status(200).json({ success: true, projects });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to archive project', details: err.message });
    }
  });

  router.patch('/projects/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await projectProvider.unarchive(projectId, auth.userId);
      const projects = [];
      if (projectProviders.nosql) {
        projects.push(...await projectProviders.nosql.list(auth.userId));
      }
      if (projectProviders.sql) {
        projects.push(...await projectProviders.sql.list(auth.userId));
      }
      if (projectProviders.default) {
        projects.push(...await projectProviders.default.list(auth.userId));
      }
      res.status(200).json({ success: true, projects });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to unarchive project', details: err.message });
    }
  });

  router.get('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;
      const exportId = req.params.export_id;

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }

      const data = await exportProvider!.getById(exportId);

      res.json({ data });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch export data', details: err.message });
    }
  });

  router.post('/projects/:id/exports', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;
      const { name, description, collectionName } = req.body;

      if (!name || !collectionName) {
        return res.status(400).json({ error: 'Missing export name or collectionName' });
      }

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const newExport = await exportProvider!.create({
        name,
        description,
        collectionName,
        projectId
      });

      await projectProvider.addExportToProject(projectId, newExport.id);

      res.status(201).json({ data: newExport });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create export', details: err.message });
    }
  });

  router.get('/projects/:id/members', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      const projectId = req.params.id;

      const projectProvider = await getProjectProvider(projectId);
      if (!projectProvider) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const project = await projectProvider.getById(projectId, true);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      res.json({ members: project.members });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project members', details: err.message });
    }
  });

  return router;
}

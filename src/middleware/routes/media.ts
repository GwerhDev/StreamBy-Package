import { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { createJob, getJob } from '../../services/jobQueue';
import { runIngestJob } from '../../services/mediaProcessor';
import { createStorageProvider } from '../../providers/storage';
import { Auth } from '../../types';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { MongoClient } from 'mongodb';
import { publicJob } from '../../services/workerJobs';
import { scopeReachesProject } from '../../services/auth';

function getMetadataCollection() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db().collection('media_metadata');
}

function getVersionsCollection() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db().collection('asset_versions');
}

export function mediaRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();
  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);
  const Project = getModel('projects');

  // GET /jobs/:jobId — poll job status
  // Only for whoever started it, or a member of its project: someone else's job is as if it
  // didn't exist.
  router.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const job = await getJob(req.params.jobId);
      if (!job) return res.status(404).json({ message: 'Job not found' });
      // With an API token, only a job of a project it reaches.
      if (!scopeReachesProject(auth.apiToken, job.projectId)) return res.status(404).json({ message: 'Job not found' });
      if (job.userId !== auth.userId) {
        const project = await Project.findOne({ _id: job.projectId });
        if (!isProjectMember(project, auth.userId)) return res.status(404).json({ message: 'Job not found' });
      }
      res.json({ job: publicJob(job) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch job', details: err.message });
    }
  });

  // POST /projects/:projectId/jobs/ingest — queue an ingest job for an already-uploaded file
  router.post('/projects/:projectId/jobs/ingest', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = await createJob('ingest', auth.userId, projectId, { fileId });

      // Run async — response returns immediately with jobId
      setImmediate(() => runIngestJob(job.jobId, fileId, projectId));

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // GET /projects/:projectId/assets/:fileId/metadata
  router.get('/projects/:projectId/assets/:fileId/metadata', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const col = getMetadataCollection();
      if (!col) return res.status(500).json({ message: 'Database not available' });

      const meta = await col.findOne({ assetId: fileId, projectId });
      res.json({ metadata: meta ?? null });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // PATCH /projects/:projectId/assets/:fileId/metadata — update custom tags
  router.patch('/projects/:projectId/assets/:fileId/metadata', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;
      const { customTags } = req.body;

      if (!customTags || typeof customTags !== 'object') {
        return res.status(400).json({ message: 'customTags object is required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const col = getMetadataCollection();
      if (!col) return res.status(500).json({ message: 'Database not available' });

      await col.updateOne(
        { assetId: fileId, projectId },
        { $set: { customTags, updatedAt: new Date() } },
        { upsert: true },
      );

      res.json({ message: 'Metadata updated' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // GET /projects/:projectId/assets/:fileId/versions
  router.get('/projects/:projectId/assets/:fileId/versions', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const col = getVersionsCollection();
      if (!col) return res.status(500).json({ message: 'Database not available' });

      const versions = await col
        .find({ assetId: fileId, projectId })
        .sort({ version: -1 })
        .toArray();

      res.json({ versions });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

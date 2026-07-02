import { Router, Request, Response } from 'express';
import { StreamByConfig, StorageAdapter } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { createJob, getJob } from '../../services/jobQueue';
import {
  runIngestJob,
  runTranscodeJob,
  runThumbnailJob,
  runCaptionJob,
} from '../../services/mediaProcessor';
import { createStorageProvider } from '../../providers/storage';
import { Auth } from '../../types';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { MongoClient } from 'mongodb';

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
  router.get('/jobs/:jobId', (req: Request, res: Response) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    res.json({ job });
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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('ingest', auth.userId, projectId, { fileId });

      // Run async — response returns immediately with jobId
      setImmediate(() => runIngestJob(job.jobId, fileId, projectId));

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/jobs/transcode
  router.post('/projects/:projectId/jobs/transcode', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, codec, resolution, outputFormat, bitrate, audioCodec } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('transcode', auth.userId, projectId, {
        fileId, codec, resolution, outputFormat, bitrate, audioCodec,
      });

      setImmediate(() =>
        runTranscodeJob(job.jobId, fileId, projectId, { codec, resolution, outputFormat, bitrate, audioCodec }, adapter),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/jobs/thumbnail
  router.post('/projects/:projectId/jobs/thumbnail', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, timecode, resolution, strategy } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('thumbnail', auth.userId, projectId, { fileId, timecode, resolution, strategy });

      setImmediate(() => runThumbnailJob(job.jobId, fileId, projectId, { timecode, resolution, strategy }));

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/jobs/caption
  router.post('/projects/:projectId/jobs/caption', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, sourceLanguage, outputFormat, provider } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('caption', auth.userId, projectId, { fileId, sourceLanguage, outputFormat, provider });

      setImmediate(() => runCaptionJob(job.jobId, fileId, projectId, { sourceLanguage, outputFormat, provider }));

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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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

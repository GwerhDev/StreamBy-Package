import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { createJob } from '../../services/jobQueue';
import { runTranscriptionJob, runUpscaleJob, runGenerateAssetJob, buildPipelineSuggestion } from '../../services/aiProcessor';
import { Auth } from '../../types';

const AVAILABLE_NODE_TYPES = [
  'dataSourceNode', 'jsonInputNode', 'apiConnectionNode',
  'processNode', 'filterNode',
  'ingestNode', 'transcodeNode', 'captionNode', 'thumbnailNode',
  'renderJobNode', 'formatConvertNode', 'lodNode', 'assetDependencyNode',
  'reviewGateNode', 'annotationNode',
  'qcCheckNode', 'deliverableNode', 'distributionNode',
  'transcriptionNode', 'upscaleNode', 'proceduralAssetNode', 'pipelineSuggestNode',
];

export function aiRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // POST /projects/:projectId/jobs/transcription
  router.post('/projects/:projectId/jobs/transcription', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, model, sourceLanguage, outputFormats, provider, credentialId } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('transcription', auth.userId, projectId, { fileId, model, sourceLanguage, outputFormats, provider, credentialId });

      setImmediate(() =>
        runTranscriptionJob(job.jobId, fileId, projectId, { model, sourceLanguage, outputFormats, provider, credentialId }),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/jobs/upscale
  router.post('/projects/:projectId/jobs/upscale', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, scale, model, mode, credentialId } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('upscale', auth.userId, projectId, { fileId, scale, model, mode, credentialId });

      setImmediate(() =>
        runUpscaleJob(job.jobId, fileId, projectId, { scale, model, mode, credentialId }),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/jobs/generate-asset
  router.post('/projects/:projectId/jobs/generate-asset', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { assetType, provider, prompt, seed, credentialId } = req.body;

      if (!prompt) return res.status(400).json({ message: 'prompt is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = createJob('generate-asset', auth.userId, projectId, { assetType, provider, prompt, seed, credentialId });

      setImmediate(() =>
        runGenerateAssetJob(job.jobId, projectId, { assetType, provider, prompt, seed, credentialId }),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/pipeline-suggest
  router.post('/projects/:projectId/pipeline-suggest', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { nodeSchema } = req.body;

      if (!nodeSchema?.nodes) return res.status(400).json({ message: 'nodeSchema is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const suggestion = await buildPipelineSuggestion(nodeSchema, AVAILABLE_NODE_TYPES);
      res.json({ suggestion });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { createJob, getJob } from '../../services/jobQueue';
import { runRenderJob, runFormatConvertJob, runLodJob, resolveAssetDependencyGraph } from '../../services/vfxProcessor';
import { Auth } from '../../types';

export function renderFarmRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // A project's render farms are its workers: see routes/worker.

  // ─── VFX Jobs ────────────────────────────────────────────────────────────────

  router.post('/projects/:projectId/jobs/render', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, renderer, renderFarmConnectionId, frameRange, resolution, samples, outputFormat } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = await createJob('render', auth.userId, projectId, { fileId, renderer, renderFarmConnectionId, frameRange, resolution, samples, outputFormat });

      setImmediate(() =>
        runRenderJob(job.jobId, fileId, projectId, { renderer, renderFarmConnectionId, frameRange, resolution, samples, outputFormat }),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/jobs/format-convert', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, inputFormat, outputFormat, applyTransforms, embedTextures } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = await createJob('format-convert', auth.userId, projectId, { fileId, inputFormat, outputFormat, applyTransforms, embedTextures });

      setImmediate(() =>
        runFormatConvertJob(job.jobId, fileId, projectId, { inputFormat, outputFormat, applyTransforms, embedTextures }),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/jobs/lod', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { fileId, levels, reductionRatios, algorithm, outputFormat } = req.body;

      if (!fileId) return res.status(400).json({ message: 'fileId is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const job = await createJob('lod', auth.userId, projectId, { fileId, levels, reductionRatios, algorithm, outputFormat });

      setImmediate(() =>
        runLodJob(job.jobId, fileId, projectId, { levels, reductionRatios, algorithm, outputFormat }),
      );

      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Asset Dependency Graph ──────────────────────────────────────────────────

  router.get('/projects/:projectId/assets/:fileId/dependency-graph', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, fileId } = req.params;
      const maxDepth = Number(req.query.maxDepth ?? 5);

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const graph = await resolveAssetDependencyGraph(projectId, fileId, maxDepth);
      res.json({ graph });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

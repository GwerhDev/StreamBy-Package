import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { ObjectId } from 'mongodb';

export function workflowRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // A project has exactly one Workflow (the central canvas). It is stored as the
  // single `project.workflow` object. Reads fall back to the legacy `workflows[0]`
  // array so pre-migration data keeps working; PATCH upserts and writes only the
  // new single field (and clears the legacy array on Mongo).
  const resolveWorkflow = (project: any): any | null =>
    project.workflow ?? (project.workflows ?? [])[0] ?? null;

  router.get('/projects/:id/workflow', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const workflow = resolveWorkflow(project);
      if (!workflow) return res.status(404).json({ message: 'No workflow found for this project' });

      res.json({ data: workflow, message: 'Workflow fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch workflow', details: err.message });
    }
  });

  router.patch('/projects/:id/workflow', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const projectId = req.params.id;
      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const now = new Date();
      const existing = resolveWorkflow(project); // upsert: create the single workflow if absent
      const base = existing ?? {
        id: randomUUID(),
        name: 'Workflow',
        description: '',
        status: 'draft',
        projectId,
        nodeSchema: null,
        createdAt: now,
      };

      const { name, description, status, nodeSchema } = req.body;
      const updated = {
        ...base,
        id: base.id,
        projectId,
        name: name ?? base.name,
        description: description ?? base.description,
        status: status ?? base.status,
        nodeSchema: nodeSchema !== undefined ? nodeSchema : base.nodeSchema,
        updatedAt: now,
      };

      if (project.dbType === 'sql') {
        const SqlProject = getModel('projects', 'sql');
        await SqlProject.update({ _id: projectId }, { workflow: updated } as any);
      } else {
        await Project.update(
          { _id: new ObjectId(projectId) },
          { $set: { workflow: updated }, $unset: { workflows: '' } } as any,
        );
      }

      res.json({ data: updated, message: 'Workflow updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update workflow', details: err.message });
    }
  });

  return router;
}

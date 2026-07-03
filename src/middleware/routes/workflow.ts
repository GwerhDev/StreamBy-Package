import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { ObjectId } from 'mongodb';

export function workflowRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  router.get('/projects/:id/workflows', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      res.json({ data: project.workflows ?? [], message: 'Workflows fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch workflows', details: err.message });
    }
  });

  router.get('/projects/:id/workflows/:workflow_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      const workflow = (project.workflows ?? []).find((w: any) => w.id === req.params.workflow_id);
      if (!workflow) return res.status(404).json({ message: 'Workflow not found' });

      res.json({ data: workflow, message: 'Workflow fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch workflow', details: err.message });
    }
  });

  router.post('/projects/:id/workflows', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const projectId = req.params.id;
      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const { name, description } = req.body;
      if (!name) return res.status(400).json({ message: 'Missing workflow name' });

      const now = new Date();
      const workflow = {
        id: randomUUID(),
        name,
        description: description ?? '',
        status: 'draft',
        projectId,
        nodeSchema: null,
        createdAt: now,
        updatedAt: now,
      };

      if (project.dbType === 'sql') {
        const SqlProject = getModel('projects', 'sql');
        const currentWorkflows: any[] = project.workflows ?? [];
        await SqlProject.update({ _id: projectId }, { workflows: [...currentWorkflows, workflow] } as any);
      } else {
        await Project.update(
          { _id: new ObjectId(projectId) },
          { $push: { workflows: workflow } } as any,
        );
      }

      res.status(201).json({ data: workflow, message: 'Workflow created successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create workflow', details: err.message });
    }
  });

  router.patch('/projects/:id/workflows/:workflow_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const { id: projectId, workflow_id: workflowId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const existing = (project.workflows ?? []).find((w: any) => w.id === workflowId);
      if (!existing) return res.status(404).json({ message: 'Workflow not found' });

      const { name, description, status, nodeSchema } = req.body;
      const updated = {
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        status: status ?? existing.status,
        nodeSchema: nodeSchema !== undefined ? nodeSchema : existing.nodeSchema,
        updatedAt: new Date(),
      };

      if (project.dbType === 'sql') {
        const SqlProject = getModel('projects', 'sql');
        const updatedWorkflows = (project.workflows ?? []).map((w: any) => w.id === workflowId ? updated : w);
        await SqlProject.update({ _id: projectId }, { workflows: updatedWorkflows } as any);
      } else {
        await Project.update(
          { _id: new ObjectId(projectId), 'workflows.id': workflowId },
          {
            $set: {
              'workflows.$.name': updated.name,
              'workflows.$.description': updated.description,
              'workflows.$.status': updated.status,
              'workflows.$.nodeSchema': updated.nodeSchema,
              'workflows.$.updatedAt': updated.updatedAt,
            },
          } as any,
        );
      }

      res.json({ data: updated, message: 'Workflow updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update workflow', details: err.message });
    }
  });

  router.delete('/projects/:id/workflows/:workflow_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const { id: projectId, workflow_id: workflowId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const existing = (project.workflows ?? []).find((w: any) => w.id === workflowId);
      if (!existing) return res.status(404).json({ message: 'Workflow not found' });

      if (project.dbType === 'sql') {
        const SqlProject = getModel('projects', 'sql');
        const updatedWorkflows = (project.workflows ?? []).filter((w: any) => w.id !== workflowId);
        await SqlProject.update({ _id: projectId }, { workflows: updatedWorkflows } as any);
      } else {
        await Project.update(
          { _id: new ObjectId(projectId) },
          { $pull: { workflows: { id: workflowId } } } as any,
        );
      }

      res.json({ message: 'Workflow deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete workflow', details: err.message });
    }
  });

  return router;
}

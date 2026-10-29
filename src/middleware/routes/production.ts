import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig } from '../../types';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { getModel } from '../../models/manager';
import { Auth } from '../../types';
import crypto from 'crypto';
import { deleteDeliverablesOf } from '../../services/deliverables';
import { checkProductionFields } from '../../services/productionFields';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

const SHOT_FIELDS = ['name', 'description', 'status', 'assignees', 'assetId', 'exportId', 'dueDate', 'order'] as const;
const TASK_FIELDS = ['name', 'status', 'priority', 'assignee', 'dueDate', 'notes'] as const;

const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

const summaryOf = (tasks: { status?: string; priority?: string }[]) => {
  const open = tasks.filter(t => t.status !== 'done');
  const priority = open.reduce<string | null>((top, t) =>
    (t.priority && (PRIORITY_RANK[t.priority] ?? 0) > (top ? PRIORITY_RANK[top] : 0) ? t.priority : top), null);
  return { done: tasks.length - open.length, total: tasks.length, priority };
};

export function productionRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // ── Sequences ──────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/sequences', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const sequences = await db.collection('production_sequences')
        .find({ projectId })
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      res.json({ sequences });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/sequences', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const checked = checkProductionFields(req.body, ['name', 'description', 'order'], project, { creating: true });
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const { values } = checked;

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const now = new Date();
      const sequence = {
        id: crypto.randomUUID(),
        projectId,
        name: values.name,
        description: values.description ?? null,
        order: values.order ?? 0,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('production_sequences').insertOne({ ...sequence });
      res.status(201).json({ sequence });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/sequences/:seqId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const checked = checkProductionFields(req.body, ['name', 'description', 'order'], project);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const $set: Record<string, any> = { ...checked.values, updatedAt: new Date() };

      const result = await db.collection('production_sequences').findOneAndUpdate(
        { id: seqId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Sequence not found' });
      res.json({ sequence: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/sequences/:seqId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      // With its shots, and their tasks and deliverables: nothing is left behind.
      const shotIds = (await db.collection('production_shots').find({ sequenceId: seqId, projectId }).toArray()).map(s => s.id);
      const { deletedCount } = await db.collection('production_sequences').deleteOne({ id: seqId, projectId });
      if (!deletedCount) return res.status(404).json({ message: 'Sequence not found' });
      await db.collection('production_shots').deleteMany({ sequenceId: seqId, projectId });
      if (shotIds.length) await db.collection('production_tasks').deleteMany({ projectId, shotId: { $in: shotIds } });
      await deleteDeliverablesOf(projectId, { shotIds });

      res.json({ message: 'Sequence deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Shots ──────────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/sequences/:seqId/shots', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const shots = await db.collection('production_shots')
        .find({ sequenceId: seqId, projectId })
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      // Each shot with how its tasks go, as a board's card shows it: how many are done of how
      // many, and the highest priority among those still open.
      const tasks = shots.length
        ? await db.collection('production_tasks')
          .find({ projectId, shotId: { $in: shots.map(sh => sh.id) } })
          .project({ shotId: 1, status: 1, priority: 1 })
          .toArray()
        : [];
      res.json({ shots: shots.map(sh => ({ ...sh, taskSummary: summaryOf(tasks.filter(t => t.shotId === sh.id)) })) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/sequences/:seqId/shots', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const checked = checkProductionFields(req.body, SHOT_FIELDS, project, { creating: true });
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const { values } = checked;

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      if (!(await db.collection('production_sequences').findOne({ id: seqId, projectId }))) {
        return res.status(404).json({ message: 'Sequence not found' });
      }

      const now = new Date();
      const shot = {
        id: crypto.randomUUID(),
        sequenceId: seqId,
        projectId,
        name: values.name,
        description: values.description ?? null,
        order: values.order ?? 0,
        status: values.status ?? 'todo',
        assignedTo: values.assignedTo ?? [],
        assetId: values.assetId ?? null,
        exportId: values.exportId ?? null,
        dueDate: values.dueDate ?? null,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('production_shots').insertOne({ ...shot });
      res.status(201).json({ shot });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/shots/:shotId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const checked = checkProductionFields(req.body, SHOT_FIELDS, project);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const $set: Record<string, any> = { ...checked.values, updatedAt: new Date() };

      const result = await db.collection('production_shots').findOneAndUpdate(
        { id: shotId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Shot not found' });
      res.json({ shot: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/shots/:shotId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('production_shots').deleteOne({ id: shotId, projectId });
      await db.collection('production_tasks').deleteMany({ shotId, projectId });
      await deleteDeliverablesOf(projectId, { shotIds: [shotId] });

      res.json({ message: 'Shot deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/shots/:shotId/tasks', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const tasks = await db.collection('production_tasks')
        .find({ shotId, projectId })
        .sort({ createdAt: 1 })
        .toArray();

      res.json({ tasks });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/shots/:shotId/tasks', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const checked = checkProductionFields(req.body, TASK_FIELDS, project, { creating: true });
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const { values } = checked;

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      if (!(await db.collection('production_shots').findOne({ id: shotId, projectId }))) {
        return res.status(404).json({ message: 'Shot not found' });
      }

      const now = new Date();
      const task = {
        id: crypto.randomUUID(),
        shotId,
        projectId,
        name: values.name,
        status: values.status ?? 'todo',
        priority: values.priority ?? 'medium',
        assignedTo: values.assignedTo ?? null,
        dueDate: values.dueDate ?? null,
        notes: values.notes ?? null,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('production_tasks').insertOne({ ...task });
      res.status(201).json({ task });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/shots/:shotId/tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId, taskId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const checked = checkProductionFields(req.body, TASK_FIELDS, project);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const $set: Record<string, any> = { ...checked.values, updatedAt: new Date() };

      const result = await db.collection('production_tasks').findOneAndUpdate(
        { id: taskId, shotId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Task not found' });
      res.json({ task: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/shots/:shotId/tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId, taskId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('production_tasks').deleteOne({ id: taskId, shotId, projectId });
      res.json({ message: 'Task deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

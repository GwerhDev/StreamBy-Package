import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig } from '../../types';
import { isProjectMember } from '../../utils/auth';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { getModel } from '../../models/manager';
import { Auth } from '../../types';
import crypto from 'crypto';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

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
      const { name, description, order } = req.body;
      if (!name) return res.status(400).json({ message: 'name is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const now = new Date();
      const sequence = {
        id: crypto.randomUUID(),
        projectId,
        name,
        description: description ?? null,
        order: order ?? 0,
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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const { name, description, order } = req.body;
      const $set: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) $set.name = name;
      if (description !== undefined) $set.description = description;
      if (order !== undefined) $set.order = order;

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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('production_sequences').deleteOne({ id: seqId, projectId });
      await db.collection('production_shots').deleteMany({ sequenceId: seqId, projectId });

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

      res.json({ shots });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/sequences/:seqId/shots', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const { name, description, status, assignedTo, assetId, exportId, dueDate, order } = req.body;
      if (!name) return res.status(400).json({ message: 'name is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const now = new Date();
      const shot = {
        id: crypto.randomUUID(),
        sequenceId: seqId,
        projectId,
        name,
        description: description ?? null,
        order: order ?? 0,
        status: status ?? 'todo',
        assignedTo: assignedTo ?? [],
        assetId: assetId ?? null,
        exportId: exportId ?? null,
        dueDate: dueDate ? new Date(dueDate) : null,
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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const { name, description, status, assignedTo, assetId, exportId, dueDate, order } = req.body;
      const $set: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) $set.name = name;
      if (description !== undefined) $set.description = description;
      if (status !== undefined) $set.status = status;
      if (assignedTo !== undefined) $set.assignedTo = assignedTo;
      if (assetId !== undefined) $set.assetId = assetId;
      if (exportId !== undefined) $set.exportId = exportId;
      if (dueDate !== undefined) $set.dueDate = dueDate ? new Date(dueDate) : null;
      if (order !== undefined) $set.order = order;

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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('production_shots').deleteOne({ id: shotId, projectId });
      await db.collection('production_tasks').deleteMany({ shotId, projectId });

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
      const { name, status, priority, assignedTo, dueDate, notes } = req.body;
      if (!name) return res.status(400).json({ message: 'name is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const now = new Date();
      const task = {
        id: crypto.randomUUID(),
        shotId,
        projectId,
        name,
        status: status ?? 'todo',
        priority: priority ?? 'medium',
        assignedTo: assignedTo ?? null,
        dueDate: dueDate ? new Date(dueDate) : null,
        notes: notes ?? null,
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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const { name, status, priority, assignedTo, dueDate, notes } = req.body;
      const $set: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) $set.name = name;
      if (status !== undefined) $set.status = status;
      if (priority !== undefined) $set.priority = priority;
      if (assignedTo !== undefined) $set.assignedTo = assignedTo;
      if (dueDate !== undefined) $set.dueDate = dueDate ? new Date(dueDate) : null;
      if (notes !== undefined) $set.notes = notes;

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
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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

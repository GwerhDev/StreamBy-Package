import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig } from '../../types';
import { isProjectMember } from '../../utils/auth';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { getModel } from '../../models/manager';
import { Auth, Pipeline, PipelineRef } from '../../types';
import crypto from 'crypto';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

// A Pipeline is a sub-workflow scoped to a project. The `pipelines` collection is the
// source of truth (holds the full nodeSchema); ProjectInfo.pipelines mirrors lightweight
// refs so the sidebar can list them without loading every schema.
export function pipelineRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  const toRef = (p: Pick<Pipeline, 'id' | 'name' | 'order'>): PipelineRef => ({ id: p.id, name: p.name, order: p.order });

  // Rewrite ProjectInfo.pipelines from the current collection state, sorted by order.
  const syncProjectRefs = async (projectId: string) => {
    const db = getDb();
    if (!db) return;
    const all = await db.collection('pipelines')
      .find({ projectId })
      .project({ _id: 0, id: 1, name: 1, order: 1 })
      .sort({ order: 1, createdAt: 1 })
      .toArray();
    const refs = all.map(p => toRef(p as unknown as Pipeline));
    await Project.update({ _id: projectId }, { pipelines: refs } as any);
  };

  router.get('/projects/:projectId/pipelines', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const pipelines = await db.collection('pipelines')
        .find({ projectId })
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      res.json({ pipelines });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/pipelines', async (req: Request, res: Response) => {
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
      const pipeline: Omit<Pipeline, '_id'> = {
        id: crypto.randomUUID(),
        projectId,
        name,
        description: description ?? null,
        order: order ?? (project.pipelines?.length ?? 0),
        nodeSchema: null,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('pipelines').insertOne({ ...pipeline });
      await syncProjectRefs(projectId);
      res.status(201).json({ pipeline });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/projects/:projectId/pipelines/:pipelineId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, pipelineId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const pipeline = await db.collection('pipelines').findOne({ id: pipelineId, projectId });
      if (!pipeline) return res.status(404).json({ message: 'Pipeline not found' });

      res.json({ pipeline });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/pipelines/:pipelineId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, pipelineId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const { name, description, nodeSchema, order } = req.body;
      const $set: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) $set.name = name;
      if (description !== undefined) $set.description = description;
      if (nodeSchema !== undefined) $set.nodeSchema = nodeSchema;
      if (order !== undefined) $set.order = order;

      const result = await db.collection('pipelines').findOneAndUpdate(
        { id: pipelineId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Pipeline not found' });
      // Only name/order affect the lightweight refs.
      if (name !== undefined || order !== undefined) await syncProjectRefs(projectId);
      res.json({ pipeline: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/pipelines/:pipelineId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, pipelineId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('pipelines').deleteOne({ id: pipelineId, projectId });
      await syncProjectRefs(projectId);
      res.json({ message: 'Pipeline deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

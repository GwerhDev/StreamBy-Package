import { Router, Request, Response } from 'express';
import { addToWorkflow, removeFromWorkflow } from '../../services/workflowResources';
import { MongoClient } from 'mongodb';
import { StreamByConfig } from '../../types';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { tokenAllows } from '../../services/auth';
import { cardKey, numberCards, readKey } from '../../services/cardKeys';
import {
  advanceRuns, checkTriggers, deleteRunsOf, describeRun, listRuns, startRun, triggersOf, usePipelineRuns,
} from '../../services/pipelineRuns';
import { callbackBaseOf } from './worker';
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
//
// Its steps are done by people and by workers, and each card linked to it goes through them in
// a run of its own (see services/pipelineRuns): started by hand, or by its triggers.
export function pipelineRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');
  usePipelineRuns(config);

  // A pipeline as it's answered: with its triggers (none, for one saved before it had them).
  const withTriggers = (pipeline: any) => (pipeline ? { ...pipeline, triggers: triggersOf(pipeline) } : pipeline);

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

      res.json({ pipelines: pipelines.map(withTriggers) });
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
      const triggers = req.body.triggers === undefined ? [] : checkTriggers(req.body.triggers);
      if ('error' in triggers) return res.status(400).json({ message: triggers.error });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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
        triggers,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('pipelines').insertOne({ ...pipeline });
      await syncProjectRefs(projectId);
      await addToWorkflow(projectId, 'pipeline', pipeline);
      res.status(201).json({ pipeline, pipelines: (await Project.findOne({ _id: projectId }))?.pipelines ?? [] });
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

      res.json({ pipeline: withTriggers(pipeline) });
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
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const { name, description, nodeSchema, order } = req.body;
      const $set: Record<string, any> = { updatedAt: new Date() };
      if (req.body.triggers !== undefined) {
        const triggers = checkTriggers(req.body.triggers);
        if ('error' in triggers) return res.status(400).json({ message: triggers.error });
        $set.triggers = triggers;
      }
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
      // Its steps changed: its runs go on by them.
      if (nodeSchema !== undefined) await advanceRuns(project, { pipelineId });
      res.json({ pipeline: withTriggers(result) });
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
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('pipelines').deleteOne({ id: pipelineId, projectId });
      await deleteRunsOf(projectId, { pipelineId });
      // Its cards are in no pipeline any more.
      await db.collection('production_shots').updateMany({ projectId, pipelineId }, { $set: { pipelineId: null } });
      await syncProjectRefs(projectId);
      await removeFromWorkflow(projectId, 'pipeline', pipelineId);
      res.json({ message: 'Pipeline deleted', pipelines: (await Project.findOne({ _id: projectId }))?.pipelines ?? [] });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Runs ──

  // Each run as it's shown: its card (with its key), and each step's state.
  const describe = async (project: any, runs: Awaited<ReturnType<typeof listRuns>>) => {
    const db = getDb();
    if (!runs.length || !db) return [];
    const projectId = String(project._id ?? project.id);
    const [pipelines, cards, key] = await Promise.all([
      db.collection('pipelines').find({ projectId, id: { $in: [...new Set(runs.map(r => r.pipelineId))] } }).toArray(),
      db.collection('production_shots').find({ projectId, id: { $in: [...new Set(runs.map(r => r.shotId))] } }).toArray(),
      readKey(projectId, project.name),
    ]);
    return runs.map(run => {
      const card: any = cards.find((c: any) => c.id === run.shotId);
      return describeRun(run, pipelines.find((p: any) => p.id === run.pipelineId), card ? { ...card, key: cardKey(key, card) } : null);
    });
  };

  // A pipeline's runs, newest first; of one card with ?shotId=.
  router.get('/projects/:projectId/pipelines/:pipelineId/runs', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, pipelineId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      if (!(await db.collection('pipelines').findOne({ id: pipelineId, projectId }))) return res.status(404).json({ message: 'Pipeline not found' });
      const shotId = typeof req.query.shotId === 'string' && req.query.shotId ? req.query.shotId : undefined;
      res.json({ runs: await describe(project, await listRuns(projectId, { pipelineId, shotId })) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // A card's runs, of every pipeline it went through, newest first: the card by its id or its key.
  router.get('/projects/:projectId/production/shots/:shot/pipeline-runs', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shot } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      let card: any = await db.collection('production_shots').findOne({ id: shot, projectId });
      if (!card) {
        await numberCards(projectId);
        const key = await readKey(projectId, project.name);
        card = (await db.collection('production_shots').find({ projectId }).toArray())
          .find((c: any) => cardKey(key, c)?.toLowerCase() === shot.trim().toLowerCase());
      }
      if (!card) return res.status(404).json({ message: 'Shot not found' });
      res.json({ runs: await describe(project, await listRuns(projectId, { shotId: card.id })) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // A card's run, started by hand ({ shotId }): its workers run as whoever starts it.
  router.post('/projects/:projectId/pipelines/:pipelineId/runs', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, pipelineId } = req.params;
      const shotId = req.body?.shotId;
      if (typeof shotId !== 'string' || !shotId) return res.status(400).json({ message: 'shotId is required' });
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      if (!tokenAllows(auth.apiToken, 'jobs:run')) return res.status(403).json({ error: "This API token doesn't have the 'jobs:run' permission" });
      const result = await startRun(project, pipelineId, shotId, 'manual', auth, callbackBaseOf(req, config));
      if ('error' in result) {
        const run = result.run ? (await describe(project, [result.run]))[0] : undefined;
        return res.status(result.status).json({ message: result.error, ...(run ? { run } : {}) });
      }
      res.status(201).json({ run: (await describe(project, [result.run]))[0] });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

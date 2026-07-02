import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig, DistributionConnection, QcReportRecord, DeliveryTarget } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { emitToUser } from '../../services/wsHub';
import { Auth } from '../../types';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import crypto from 'crypto';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

function broadcastDeliveryUpdate(userId: string, payload: object) {
  emitToUser(userId, { type: 'jobEvent', data: payload });
}

export function distributionRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');
  const Export = getModel('exports');

  // ─── Distribution Connections ─────────────────────────────────────────────────

  router.get('/projects/:projectId/distribution-connections', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      res.json({ connections: project.distributionConnections ?? [] });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/distribution-connections', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { name, target, credentialId, config, description } = req.body;

      if (!name || !target) return res.status(400).json({ message: 'name and target are required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const connection: DistributionConnection = {
        id: crypto.randomUUID(),
        name,
        target,
        credentialId,
        config: config ?? {},
        description,
        projectId,
        createdAt: new Date(),
      };

      await Project.update(
        { _id: projectId },
        { $push: { distributionConnections: connection } },
      );

      res.status(201).json({ connection });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/distribution-connections/:connectionId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, connectionId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      await Project.update(
        { _id: projectId },
        { $pull: { distributionConnections: { id: connectionId } } },
      );

      res.json({ message: 'Connection deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Publish Deliverable ──────────────────────────────────────────────────────

  router.post('/projects/:projectId/deliverables/:exportId/publish', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, exportId } = req.params;
      const { targets }: { targets: { connectionId: string; channel?: string }[] } = req.body;

      if (!targets?.length) return res.status(400).json({ message: 'targets array is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const exportDoc = await Export.findOne({ id: exportId, projectId });
      if (!exportDoc) return res.status(404).json({ message: 'Deliverable not found' });

      const connections: DistributionConnection[] = project.distributionConnections ?? [];

      const deliveryTargets: DeliveryTarget[] = targets.map(t => {
        const conn = connections.find(c => c.id === t.connectionId);
        return {
          connectionId: t.connectionId,
          target: conn?.target ?? 'customWebhook',
          channel: t.channel,
          status: 'pending',
        };
      });

      const now = new Date();
      await Export.update(
        { id: exportId, projectId },
        {
          $set: {
            deliverableTargets: deliveryTargets,
            publishedAt: now,
            publishedBy: auth.userId,
            updatedAt: now,
          },
        },
      );

      // Dispatch async — actual upload/API call happens in the host worker
      setImmediate(() => {
        for (const dt of deliveryTargets) {
          broadcastDeliveryUpdate(auth.userId, {
            jobId: crypto.randomUUID(),
            jobType: 'distribute',
            stage: 'queued',
            progress: 5,
            assetId: exportId,
            message: `Queued publish to ${dt.target}`,
          });
        }
      });

      res.status(202).json({ deliverableTargets: deliveryTargets, publishedAt: now });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── QC Reports ───────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/assets/:assetId/qc-report', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, assetId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const report = await db.collection('qc_reports').findOne(
        { assetId, projectId },
        { sort: { generatedAt: -1 } } as any,
      );

      res.json({ report: report ?? null });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/assets/:assetId/qc-report', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, assetId } = req.params;
      const { checks } = req.body;

      if (!Array.isArray(checks)) return res.status(400).json({ message: 'checks array is required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const overallPassed = checks.every((c: any) => c.passed === true);
      const report: QcReportRecord = {
        assetId,
        projectId,
        checks,
        overallPassed,
        generatedAt: new Date(),
      };

      await db.collection('qc_reports').insertOne({ ...report });
      res.status(201).json({ report });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

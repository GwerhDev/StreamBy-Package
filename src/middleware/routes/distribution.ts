import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig, DistributionConnection, QcReportRecord, DeliveryTarget } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { Auth } from '../../types';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { sanitizeConnection, sanitizeConnections } from '../../utils/sanitize';
import crypto from 'crypto';
import { encrypt, isEncryptionKeySet } from '../../utils/encryption';
import { blockersOfExport } from '../../services/deliverableGates';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
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
      res.json({ connections: sanitizeConnections(project.distributionConnections) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/distribution-connections', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { name, target, credential: credentialValue, encryptedCredential: legacyCredential, config, description } = req.body;
      // The credential, as given (`encryptedCredential` was its old name: it was always the
      // value itself), stored encrypted.
      const credential = credentialValue ?? legacyCredential;
      if (credential && !isEncryptionKeySet()) return res.status(500).json({ message: 'Encryption key is not set' });
      const encryptedCredential = credential ? encrypt(String(credential)) : undefined;

      if (!name || !target) return res.status(400).json({ message: 'name and target are required' });

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const connection: DistributionConnection = {
        id: crypto.randomUUID(),
        name,
        target,
        encryptedCredential,
        config: config ?? {},
        description,
        projectId,
        createdAt: new Date(),
      };

      await Project.update(
        { _id: projectId },
        { $push: { distributionConnections: connection } },
      );

      res.status(201).json({ connection: sanitizeConnection(connection) });
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
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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

  // An export marked as published: when, by whom, and where to (its distribution connections,
  // each a channel if given). Only a record: StreamBy uploads nothing to a platform. Not while a
  // deliverable of it is held by a gate before it in the workflow.
  router.post('/projects/:projectId/deliverables/:exportId/publish', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, exportId } = req.params;
      const targets = req.body?.targets ?? [];
      if (!Array.isArray(targets) || !targets.every((t: any) => t && typeof t.connectionId === 'string' && (t.channel === undefined || typeof t.channel === 'string'))) {
        return res.status(400).json({ message: 'targets must be a list of { connectionId, channel? }' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const exportDoc = await Export.findOne({ id: exportId, projectId });
      if (!exportDoc) return res.status(404).json({ message: 'Deliverable not found' });

      const blockedBy = await blockersOfExport(project, exportId);
      if (blockedBy.length) {
        return res.status(409).json({ message: `Blocked: ${blockedBy.map(b => `${b.label} (${b.reason})`).join('; ')}`, blockedBy });
      }

      const connections: DistributionConnection[] = project.distributionConnections ?? [];
      const unknown = targets.find((t: any) => !connections.some(c => c.id === t.connectionId));
      if (unknown) return res.status(400).json({ message: `${unknown.connectionId} isn't a distribution connection of the project` });
      const now = new Date();
      const publishedTo: DeliveryTarget[] = targets.map((t: any) => ({
        connectionId: t.connectionId,
        target: connections.find(c => c.id === t.connectionId)!.target,
        ...(t.channel ? { channel: t.channel } : {}),
      }));

      await Export.update(
        { id: exportId, projectId },
        { $set: { deliverableTargets: publishedTo, publishedAt: now, publishedBy: auth.userId, updatedAt: now } },
      );
      res.json({ deliverableTargets: publishedTo, publishedAt: now, publishedBy: auth.userId });
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
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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

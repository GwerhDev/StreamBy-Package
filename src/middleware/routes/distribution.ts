import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig, QcReportRecord } from '../../types';
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

  // ─── Publish Deliverable ──────────────────────────────────────────────────────

  // An export marked as published: when, and by whom. Only a record: StreamBy sends nothing to
  // a platform (a build or a site takes its deliverables from its catalog, see
  // deliverableCatalog). Not while a deliverable of it is held by a gate before it in the workflow.
  router.post('/projects/:projectId/deliverables/:exportId/publish', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, exportId } = req.params;
      if (req.body?.targets !== undefined) {
        return res.status(400).json({ message: "Publishing has no targets: StreamBy sends nothing to a platform; a site takes an export's deliverables from its catalog" });
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

      const now = new Date();
      await Export.update(
        { id: exportId, projectId },
        { $set: { publishedAt: now, publishedBy: auth.userId, updatedAt: now } },
      );
      res.json({ publishedAt: now, publishedBy: auth.userId });
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

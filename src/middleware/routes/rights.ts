import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig } from '../../types';
import { isProjectMember } from '../../utils/auth';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { getModel } from '../../models/manager';
import { Auth } from '../../types';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

export function rightsRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // GET /projects/:projectId/assets/:assetId/rights
  router.get('/projects/:projectId/assets/:assetId/rights', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, assetId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const rights = await db.collection('asset_rights').findOne({ assetId, projectId });
      res.json({ rights: rights ?? null });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // PUT /projects/:projectId/assets/:assetId/rights  (upsert)
  router.put('/projects/:projectId/assets/:assetId/rights', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, assetId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const { rightsHolder, licenseType, licenseUrl, territory, expiresAt, usageRestrictions, notes } = req.body;

      const now = new Date();
      const payload: Record<string, any> = {
        assetId,
        projectId,
        licenseType: licenseType ?? 'unknown',
        updatedBy: auth.userId,
        updatedAt: now,
      };
      if (rightsHolder !== undefined) payload.rightsHolder = rightsHolder;
      if (licenseUrl !== undefined) payload.licenseUrl = licenseUrl;
      if (territory !== undefined) payload.territory = territory;
      if (expiresAt !== undefined) payload.expiresAt = expiresAt ? new Date(expiresAt) : null;
      if (usageRestrictions !== undefined) payload.usageRestrictions = usageRestrictions;
      if (notes !== undefined) payload.notes = notes;

      await db.collection('asset_rights').updateOne(
        { assetId, projectId },
        { $set: payload },
        { upsert: true },
      );

      const rights = await db.collection('asset_rights').findOne({ assetId, projectId });
      res.json({ rights });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

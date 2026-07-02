import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig, ReviewSessionRecord, ReviewDecision } from '../../types';
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

function broadcastReviewUpdate(review: ReviewSessionRecord, project: any) {
  const members: { userId: string }[] = project.members ?? [];
  for (const m of members) {
    emitToUser(m.userId, { type: 'reviewEvent', data: review });
  }
}

export function reviewRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // GET /projects/:projectId/reviews
  router.get('/projects/:projectId/reviews', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const reviews = await db.collection('review_sessions')
        .find({ projectId })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ reviews });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/reviews
  router.post('/projects/:projectId/reviews', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { assetId, assetVersionId, requiredApprovers, deadline } = req.body;

      if (!assetId || !assetVersionId) {
        return res.status(400).json({ message: 'assetId and assetVersionId are required' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const now = new Date();
      const review: ReviewSessionRecord = {
        id: crypto.randomUUID(),
        projectId,
        assetId,
        assetVersionId,
        status: 'open',
        requiredApprovers: requiredApprovers ?? 1,
        approvals: [],
        deadline: deadline ? new Date(deadline) : undefined,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('review_sessions').insertOne({ ...review });
      broadcastReviewUpdate(review, project);

      res.status(201).json({ review });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // GET /projects/:projectId/reviews/:reviewId
  router.get('/projects/:projectId/reviews/:reviewId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, reviewId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const review = await db.collection('review_sessions').findOne({ id: reviewId, projectId });
      if (!review) return res.status(404).json({ message: 'Review not found' });

      res.json({ review });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /projects/:projectId/reviews/:reviewId/decision
  router.post('/projects/:projectId/reviews/:reviewId/decision', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, reviewId } = req.params;
      const { decision, comment }: { decision: ReviewDecision; comment?: string } = req.body;

      if (decision !== 'approve' && decision !== 'reject') {
        return res.status(400).json({ message: 'decision must be approve or reject' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const col = db.collection('review_sessions');
      const review = await col.findOne({ id: reviewId, projectId }) as ReviewSessionRecord | null;
      if (!review) return res.status(404).json({ message: 'Review not found' });
      if (review.status !== 'open') return res.status(409).json({ message: `Review is already ${review.status}` });

      // Remove any prior decision from this user, then add the new one
      const approvals = (review.approvals ?? []).filter(a => a.userId !== auth.userId);
      approvals.push({
        userId: auth.userId,
        username: (auth as any).username ?? auth.userId,
        decision,
        comment,
        at: new Date(),
      });

      const approveCount = approvals.filter(a => a.decision === 'approve').length;
      const hasRejection = approvals.some(a => a.decision === 'reject');

      let status: ReviewSessionRecord['status'] = 'open';
      if (hasRejection) status = 'rejected';
      else if (approveCount >= review.requiredApprovers) status = 'approved';

      const updatedAt = new Date();
      await col.updateOne(
        { id: reviewId, projectId },
        { $set: { approvals, status, updatedAt } },
      );

      const updated: ReviewSessionRecord = { ...review, approvals, status, updatedAt };
      broadcastReviewUpdate(updated, project);

      res.json({ review: updated });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── Annotations ─────────────────────────────────────────────────────────────

  router.get(
    '/projects/:projectId/assets/:assetId/versions/:versionId/annotations',
    async (req: Request, res: Response) => {
      try {
        const auth = (req as any).auth as Auth;
        const { projectId, assetId, versionId } = req.params;
        const project = await Project.findOne({ _id: projectId });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

        const db = getDb();
        if (!db) return res.status(500).json({ message: 'Database not available' });

        const annotations = await db.collection('annotations')
          .find({ assetId, assetVersionId: versionId, projectId })
          .sort({ createdAt: 1 })
          .toArray();

        res.json({ annotations });
      } catch (err: any) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  router.post(
    '/projects/:projectId/assets/:assetId/versions/:versionId/annotations',
    async (req: Request, res: Response) => {
      try {
        const auth = (req as any).auth as Auth;
        const { projectId, assetId, versionId } = req.params;
        const { type, timecode, position3d, regionRect, text } = req.body;

        if (!type || !text) return res.status(400).json({ message: 'type and text are required' });

        const project = await Project.findOne({ _id: projectId });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

        const db = getDb();
        if (!db) return res.status(500).json({ message: 'Database not available' });

        const annotation = {
          id: crypto.randomUUID(),
          assetId,
          assetVersionId: versionId,
          projectId,
          authorId: auth.userId,
          authorUsername: (auth as any).username ?? auth.userId,
          type,
          timecode,
          position3d,
          regionRect,
          text,
          resolved: false,
          createdAt: new Date(),
        };

        await db.collection('annotations').insertOne({ ...annotation });
        res.status(201).json({ annotation });
      } catch (err: any) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  router.patch(
    '/projects/:projectId/assets/:assetId/versions/:versionId/annotations/:annotationId/resolve',
    async (req: Request, res: Response) => {
      try {
        const auth = (req as any).auth as Auth;
        const { projectId, assetId, versionId, annotationId } = req.params;
        const project = await Project.findOne({ _id: projectId });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

        const db = getDb();
        if (!db) return res.status(500).json({ message: 'Database not available' });

        await db.collection('annotations').updateOne(
          { id: annotationId, assetId, assetVersionId: versionId, projectId },
          { $set: { resolved: true, resolvedBy: auth.userId } },
        );

        res.json({ message: 'Annotation resolved' });
      } catch (err: any) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  return router;
}

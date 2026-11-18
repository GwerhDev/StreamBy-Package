import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig, ReviewSessionRecord, ReviewDecision } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { emitToUser } from '../../services/wsHub';
import { Auth } from '../../types';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import crypto from 'crypto';
import { afterGateChange } from './deliverable';
import { advanceRuns } from '../../services/pipelineRuns';
import { checkNoteTime, checkNoteWithin, noteTask, noteTimecode, versionDuration, NoteTime } from '../../services/reviewNotes';
import { newTask } from '../../services/productionTasks';

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

// A version's notes changed (one added, resolved, made a task): whoever has its review open
// reads them again (an agent's note, made by MCP, shows up there).
function broadcastAnnotationsChanged(project: any, change: { assetId: string; assetVersionId: string }) {
  for (const m of (project.members ?? []) as { userId: string }[]) {
    emitToUser(m.userId, { type: 'annotationEvent', data: { projectId: String(project._id ?? project.id), ...change } });
  }
}

export function reviewRouter(config: StreamByConfig): Router {
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
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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
      // A pipeline's Review Gate waits on its card's asset's session.
      await advanceRuns(project).catch(err => console.error('❌ StreamBy pipelines: a review opened:', err?.message ?? err));

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
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

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
      // A Review Gate linked to it may pass, or stop passing.
      if (status !== review.status) await afterGateChange(req, config, project);

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
        const { type, position3d, regionRect, text } = req.body;

        if (!type || !text) return res.status(400).json({ message: 'type and text are required' });
        // A timecoded note is on an instant of the file, or a range of it.
        let noteTime: NoteTime | null = null;
        if (type === 'timecoded') {
          const checked = checkNoteTime(req.body);
          if ('error' in checked) return res.status(400).json({ message: checked.error });
          noteTime = checked.time;
        }

        const project = await Project.findOne({ _id: projectId });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

        const db = getDb();
        if (!db) return res.status(500).json({ message: 'Database not available' });

        // Within the file, when it's known how long it lasts.
        if (noteTime) {
          const version = await db.collection('asset_versions').findOne({ projectId, assetId, versionId }) as any;
          const outside = checkNoteWithin(noteTime, versionDuration(version));
          if (outside) return res.status(400).json({ message: outside });
        }
        const time = noteTime ? { ...noteTime, timecode: noteTimecode(noteTime) } : {};

        const annotation = {
          id: crypto.randomUUID(),
          assetId,
          assetVersionId: versionId,
          projectId,
          authorId: auth.userId,
          authorUsername: (auth as any).username ?? auth.userId,
          type,
          ...time,
          position3d,
          regionRect,
          text,
          resolved: false,
          createdAt: new Date(),
        };

        await db.collection('annotations').insertOne({ ...annotation });
        broadcastAnnotationsChanged(project, { assetId, assetVersionId: versionId });
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
        if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

        const db = getDb();
        if (!db) return res.status(500).json({ message: 'Database not available' });

        await db.collection('annotations').updateOne(
          { id: annotationId, assetId, assetVersionId: versionId, projectId },
          { $set: { resolved: true, resolvedBy: auth.userId } },
        );

        broadcastAnnotationsChanged(project, { assetId, assetVersionId: versionId });
        res.json({ message: 'Annotation resolved' });
      } catch (err: any) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  // A note made a task of the card (shot) its asset is linked to, its time in the task's name.
  // With several cards linked, the one it goes to is given (shotId); without one, it can't.
  router.post(
    '/projects/:projectId/assets/:assetId/versions/:versionId/annotations/:annotationId/task',
    async (req: Request, res: Response) => {
      try {
        const auth = (req as any).auth as Auth;
        const { projectId, assetId, versionId, annotationId } = req.params;
        const project = await Project.findOne({ _id: projectId });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

        const db = getDb();
        if (!db) return res.status(500).json({ message: 'Database not available' });

        const notes = db.collection('annotations');
        const note = await notes.findOne({ id: annotationId, assetId, assetVersionId: versionId, projectId }) as any;
        if (!note) return res.status(404).json({ message: 'Annotation not found' });
        if (note.type !== 'timecoded' || typeof note.startSeconds !== 'number') {
          return res.status(400).json({ message: 'Only a note on a moment of the file becomes a task' });
        }
        if (note.taskId) return res.status(409).json({ message: 'This note is already a task' });

        const cards = await db.collection('production_shots').find({ projectId, assetId }).toArray() as any[];
        if (!cards.length) return res.status(409).json({ message: 'No card on the board is linked to this asset' });
        const { shotId } = req.body ?? {};
        const card = shotId ? cards.find(c => c.id === shotId) : cards.length === 1 ? cards[0] : null;
        if (!card) {
          return res.status(shotId ? 400 : 409).json({
            message: shotId ? 'shotId must be a card linked to this asset' : 'Several cards are linked to this asset: choose one (shotId)',
            shots: cards.map(c => ({ id: c.id, key: c.key ?? null, name: c.name })),
          });
        }

        const task = newTask({ projectId, shotId: card.id, userId: auth.userId, values: noteTask(note) });
        // The note is claimed for this task before it's made, in one conditional write: of two
        // requests at once, only one finds it without a task, and the other is refused.
        const claim = { id: annotationId, projectId, taskId: task.id };
        const claimed = await notes.updateOne(
          { id: annotationId, projectId, $or: [{ taskId: { $exists: false } }, { taskId: null }] },
          { $set: { taskId: task.id, shotId: card.id } },
        );
        if (!claimed.matchedCount) return res.status(409).json({ message: 'This note is already a task' });
        try {
          await db.collection('production_tasks').insertOne({ ...task });
        } catch (err) {
          // Not made: the note is let go, so it can be made a task again.
          await notes.updateOne(claim, { $unset: { taskId: '', shotId: '' } }).catch(() => {});
          throw err;
        }
        await advanceRuns(project, { shotId: card.id }).catch(err => console.error('❌ StreamBy pipelines: a task changed:', err?.message ?? err));
        broadcastAnnotationsChanged(project, { assetId, assetVersionId: versionId });

        res.status(201).json({ task, annotation: { ...note, taskId: task.id, shotId: card.id } });
      } catch (err: any) {
        res.status(500).json({ message: err.message });
      }
    },
  );

  return router;
}

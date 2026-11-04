import { Router, Request, Response } from 'express';
import { Auth, StorageAdapter, StreamByConfig } from '../../types';
import { enqueueAutomaticJobs, publicJob } from '../../services/workerJobs';
import { callbackBaseOf } from './worker';
import { tokenAllows } from '../../services/auth';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { nosqlDb } from '../../utils/nosqlDb';
import { findVersion } from '../../services/assetVersions';
import { createDeliverable, deleteDeliverable, Deliverable, deliverablesCollection, listDeliverables } from '../../services/deliverables';
import { deliverableNodeStates, deliverableStates, gatesChanged, withState } from '../../services/deliverableGates';

const MAX_NOTE = 1000;

/**
 * Something a gate reads changed in this request: the project's members read the deliverables'
 * states again, and those held and ready now get their automatic workers, as whoever made the
 * change (not for an API token that can't run jobs).
 */
export async function afterGateChange(req: Request, config: StreamByConfig, project: any): Promise<void> {
  const auth = (req as any).auth as Auth | undefined;
  const release = auth?.userId && tokenAllows(auth.apiToken, 'jobs:run')
    ? { run: (d: Deliverable) => enqueueAutomaticJobs(project, d.assetId, d.versionId, auth, config, callbackBaseOf(req, config)) }
    : undefined;
  await gatesChanged(project, release).catch(err => console.error('❌ StreamBy deliverables: gates changed:', err?.message ?? err));
}

// A project's deliverables (see services/deliverables): marked, listed and removed, each with its
// state (ready, or blocked by the gates before it in the workflow: see services/deliverableGates).
// Removing one never deletes its asset. Marking one starts the workers set to process its kind of
// asset by themselves; marking one that's blocked holds them until it's ready. One ready whose
// workers are still held (the change that made it ready came from someone who can't run jobs)
// says so (workersWaiting), and they're started by hand.
export function deliverableRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = Router();
  const Project = getModel('projects');

  const exportsOf = (project: any): any[] => project.exports ?? [];

  // What a list shows of each: its asset's name and kind, its version's number, and the name
  // of the shot or export it's for.
  const describe = async (project: any, deliverables: Deliverable[]) => {
    const db = nosqlDb();
    const assetIds = [...new Set(deliverables.map(d => d.assetId))];
    const shotIds = [...new Set(deliverables.map(d => d.shotId).filter(Boolean))] as string[];
    const versionIds = [...new Set(deliverables.map(d => d.versionId).filter(Boolean))] as string[];
    const [files, shots, versions] = db
      ? await Promise.all([
        db.collection('storage_files').find({ projectId: project._id?.toString() ?? project.id, fileId: { $in: assetIds } }).toArray(),
        shotIds.length ? db.collection('production_shots').find({ id: { $in: shotIds } }).toArray() : [],
        versionIds.length ? db.collection('asset_versions').find({ versionId: { $in: versionIds } }).toArray() : [],
      ])
      : [[], [], []];
    const states = await deliverableStates(project, deliverables);
    return deliverables.map((d, i) => {
      const { heldJobs, ...shown } = d;
      const file: any = files.find((f: any) => f.fileId === d.assetId);
      const version: any = versions.find((v: any) => v.versionId === d.versionId);
      return {
        ...withState(shown, states[i]),
        workersWaiting: !!heldJobs && states[i].status === 'ready',
        asset: file ? { displayName: file.displayName, category: file.category, contentType: file.contentType ?? null } : null,
        version: version ? version.version : null,
        shotName: d.shotId ? (shots.find((s: any) => s.id === d.shotId) as any)?.name ?? null : null,
        exportName: d.exportId ? exportsOf(project).find((e: any) => e.id?.toString() === d.exportId)?.name ?? null : null,
      };
    });
  };

  router.get('/projects/:projectId/deliverables', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { shotId, exportId } = req.query as { shotId?: string; exportId?: string };
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const deliverables = await listDeliverables(projectId, { shotId, exportId });
      res.json({ deliverables: await describe(project, deliverables) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list deliverables', details: err.message });
    }
  });

  // The state of each Deliverable node of the workflow (as the canvas shows it): what it applies
  // to, and the gates before it that hold it.
  router.get('/projects/:projectId/deliverables/gates', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      res.json({ nodes: await deliverableNodeStates(project) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to read the deliverables\' gates', details: err.message });
    }
  });

  router.post('/projects/:projectId/deliverables', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const { assetId, versionId, shotId, exportId, note } = req.body ?? {};

      if (typeof assetId !== 'string' || !assetId) return res.status(400).json({ message: 'assetId is required' });
      if (versionId !== undefined && versionId !== null && typeof versionId !== 'string') {
        return res.status(400).json({ message: 'versionId must be a string' });
      }
      const forShot = typeof shotId === 'string' && shotId !== '';
      const forExport = typeof exportId === 'string' && exportId !== '';
      if (forShot === forExport) return res.status(400).json({ message: 'A deliverable is for a shot (shotId) or for an export (exportId), one of them' });
      if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) {
        return res.status(400).json({ message: `note must be a string of at most ${MAX_NOTE} characters` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = nosqlDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      if (!(await db.collection('storage_files').findOne({ fileId: assetId, projectId }))) {
        return res.status(404).json({ message: 'Asset not found' });
      }
      if (versionId && !(await findVersion(projectId, assetId, versionId))) {
        return res.status(404).json({ message: 'Version not found' });
      }
      if (forShot && !(await db.collection('production_shots').findOne({ id: shotId, projectId }))) {
        return res.status(404).json({ message: 'Shot not found' });
      }
      if (forExport && !exportsOf(project).some((e: any) => e.id?.toString() === exportId)) {
        return res.status(404).json({ message: 'Export not found' });
      }

      const deliverable = await createDeliverable({
        projectId,
        assetId,
        versionId: versionId || null,
        shotId: forShot ? shotId : null,
        exportId: forExport ? exportId : null,
        note: note || null,
        createdBy: auth.userId,
      });
      const [described] = await describe(project, [deliverable]);
      // The project's workers set to process its kind of asset by themselves start on it: not
      // for an API token that can't run jobs, and not yet if it's blocked (they start once it's
      // ready).
      const runs = tokenAllows(auth.apiToken, 'jobs:run');
      if (runs && described.status === 'blocked') {
        await deliverablesCollection()?.updateOne({ projectId, id: deliverable.id }, { $set: { heldJobs: true } });
      }
      const jobs = runs && described.status === 'ready'
        ? await enqueueAutomaticJobs(project, assetId, versionId || null, auth, config, callbackBaseOf(req, config)).catch(() => [])
        : [];
      res.status(201).json({ deliverable: described, jobs: jobs.map(publicJob) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to mark the deliverable', details: err.message });
    }
  });

  // A ready deliverable's workers that are still held, started as the caller. Of two starts (or a
  // start and a gate change) at once, only the one that takes the hold starts them; one not held
  // (started already, or never held) is answered with no jobs.
  router.post('/projects/:projectId/deliverables/:deliverableId/start-workers', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, deliverableId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      if (!tokenAllows(auth.apiToken, 'jobs:run')) return res.status(403).json({ message: 'Starting workers needs jobs:run' });

      const col = deliverablesCollection();
      if (!col) return res.status(500).json({ message: 'Database not available' });
      const found: any = await col.findOne({ projectId, id: deliverableId });
      if (!found) return res.status(404).json({ message: 'Deliverable not found' });
      const { _id, ...deliverable } = found;
      const [described] = await describe(project, [deliverable as Deliverable]);
      if (described.status === 'blocked') {
        return res.status(409).json({ message: `Blocked: ${described.blockedBy.map(b => `${b.label} (${b.reason})`).join('; ')}`, blockedBy: described.blockedBy });
      }

      const taken = await col.updateOne({ projectId, id: deliverableId, heldJobs: true }, { $unset: { heldJobs: '' } });
      const jobs = taken.modifiedCount
        ? await enqueueAutomaticJobs(project, deliverable.assetId, deliverable.versionId ?? null, auth, config, callbackBaseOf(req, config))
        : [];
      const [now] = await describe(project, [{ ...(deliverable as Deliverable), heldJobs: undefined }]);
      res.json({ deliverable: now, jobs: jobs.map(publicJob) });
    } catch (err: any) {
      res.status(500).json({ message: "Failed to start the deliverable's workers", details: err.message });
    }
  });

  router.delete('/projects/:projectId/deliverables/:deliverableId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, deliverableId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      if (!(await deleteDeliverable(projectId, deliverableId))) return res.status(404).json({ message: 'Deliverable not found' });
      res.json({ message: 'Deliverable removed' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to remove the deliverable', details: err.message });
    }
  });

  return router;
}

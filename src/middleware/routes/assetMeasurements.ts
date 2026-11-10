import { Router, Request, Response } from 'express';
import { Auth, StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { nosqlDb } from '../../utils/nosqlDb';
import { recordFirstVersion } from '../../services/assetVersions';
import {
  AssetBudgets, checkBudgets, checkMeasurements, EMPTY_BUDGETS, exceededBy, profileFor,
} from '../../services/assetMeasurements';

// A 3D asset's measurements, kept with each version, and the project's budgets they're checked
// against (see services/assetMeasurements).
export function assetMeasurementsRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  const budgetsOf = async (projectId: string): Promise<AssetBudgets> => {
    const doc: any = await nosqlDb()?.collection('asset_budgets').findOne({ projectId });
    return doc ? { profiles: doc.profiles ?? [], defaultProfileId: doc.defaultProfileId ?? null } : EMPTY_BUDGETS;
  };
  const chosenProfile = async (projectId: string, assetId: string): Promise<string | null> =>
    ((await nosqlDb()?.collection('media_metadata').findOne({ projectId, assetId })) as any)?.budgetProfileId ?? null;

  // The project and its asset, if the caller may (read, or with `edit`, change) them.
  const assetFor = async (req: Request, res: Response, edit = false) => {
    const auth = (req as any).auth as Auth;
    const { projectId, assetId } = req.params;
    const project = await Project.findOne({ _id: projectId });
    if (!project) { res.status(404).json({ message: 'Project not found' }); return null; }
    if (!(edit ? canEditProject(project, auth.userId) : isProjectMember(project, auth.userId))) {
      res.status(403).json({ message: 'Unauthorized' }); return null;
    }
    const db = nosqlDb();
    if (!db) { res.status(500).json({ message: 'Database not available' }); return null; }
    const file: any = await db.collection('storage_files').findOne({ fileId: assetId, projectId });
    if (!file) { res.status(404).json({ message: 'Asset not found' }); return null; }
    return { auth, project, file, db, projectId, assetId };
  };

  // ── The project's budgets ──

  router.get('/projects/:projectId/asset-budgets', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      res.json({ budgets: await budgetsOf(req.params.projectId) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to read the budgets', details: err.message });
    }
  });

  router.put('/projects/:projectId/asset-budgets', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
      const budgets = checkBudgets(req.body);
      if ('error' in budgets) return res.status(400).json({ message: budgets.error });
      const db = nosqlDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      await db.collection('asset_budgets').updateOne(
        { projectId },
        { $set: { projectId, ...budgets, updatedAt: new Date(), updatedBy: auth.userId } },
        { upsert: true },
      );
      res.json({ budgets });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to save the budgets', details: err.message });
    }
  });

  // ── An asset's profile, and its versions' measurements ──

  // The profile it's checked against (null: the project's default).
  router.put('/projects/:projectId/assets/:assetId/budget-profile', async (req: Request, res: Response) => {
    try {
      const found = await assetFor(req, res, true);
      if (!found) return;
      const profileId = req.body?.profileId ?? null;
      if (profileId !== null && !(await budgetsOf(found.projectId)).profiles.some(p => p.id === profileId)) {
        return res.status(400).json({ message: "profileId is one of the project's budget profiles, or null for its default" });
      }
      await found.db.collection('media_metadata').updateOne(
        { assetId: found.assetId, projectId: found.projectId },
        { $set: { budgetProfileId: profileId, updatedAt: new Date() } },
        { upsert: true },
      );
      res.json({ profileId });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to set the budget profile', details: err.message });
    }
  });

  // A version's measurements (its latest if none is given), checked against its profile: what
  // it measures (null if no one measured it yet), the profile, and what it has over it.
  router.get('/projects/:projectId/assets/:assetId/measurements', async (req: Request, res: Response) => {
    try {
      const found = await assetFor(req, res);
      if (!found) return;
      const { db, projectId, assetId, file } = found;
      // An asset made before versions were kept gets its first one.
      await recordFirstVersion(file);
      const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
      const versions = db.collection('asset_versions');
      const version: any = versionId
        ? await versions.findOne({ projectId, assetId, versionId })
        : (await versions.find({ projectId, assetId }).sort({ version: -1 }).limit(1).toArray())[0];
      if (!version) return res.status(404).json({ message: 'Version not found' });

      const budgets = await budgetsOf(projectId);
      const chosen = await chosenProfile(projectId, assetId);
      const profile = profileFor(budgets, chosen);
      const measurements = version.measurements ?? null;
      res.json({
        assetId, versionId: version.versionId, version: version.version,
        measurements, profile, profileId: chosen,
        exceeded: measurements ? exceededBy(measurements, profile) : [],
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to read the measurements', details: err.message });
    }
  });

  // What a version measures, as whoever opened it measured it: kept with it (each time again).
  router.put('/projects/:projectId/assets/:assetId/versions/:versionId/measurements', async (req: Request, res: Response) => {
    try {
      const found = await assetFor(req, res, true);
      if (!found) return;
      const { db, projectId, assetId, auth } = found;
      const measurements = checkMeasurements(req.body, auth.userId);
      if ('error' in measurements) return res.status(400).json({ message: measurements.error });
      const result = await db.collection('asset_versions').updateOne(
        { projectId, assetId, versionId: req.params.versionId },
        { $set: { measurements } },
      );
      if (!result.matchedCount) return res.status(404).json({ message: 'Version not found' });
      const profile = profileFor(await budgetsOf(projectId), await chosenProfile(projectId, assetId));
      res.json({ measurements, profile, exceeded: exceededBy(measurements, profile) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to save the measurements', details: err.message });
    }
  });

  return router;
}

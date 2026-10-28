import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { getModel } from '../../models/manager';
import { Auth } from '../../types';
import { nosqlDb } from '../../utils/nosqlDb';
import { checkRights, getRights, saveRights } from '../../services/rights';
import { documentStore } from '../../services/documents';
import { readSheet } from '../../services/creditsSheets';

export function rightsRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // The project, if the caller may see it (or, with `edit`, change it); otherwise the answer.
  async function projectFor(req: Request, res: Response, edit = false) {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.projectId });
    if (!project) { res.status(404).json({ message: 'Project not found' }); return null; }
    if (!(edit ? canEditProject : isProjectMember)(project, auth.userId)) { res.status(403).json({ message: 'Unauthorized' }); return null; }
    return { project, auth, projectId: String(req.params.projectId) };
  }

  router.get('/projects/:projectId/assets/:assetId/rights', async (req: Request, res: Response) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      if (!nosqlDb()) return res.status(500).json({ message: 'Database not available' });
      res.json({ rights: await getRights(found.projectId, req.params.assetId) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Sets the fields given of the asset's license metadata (who may edit the asset may).
  router.put('/projects/:projectId/assets/:assetId/rights', async (req: Request, res: Response) => {
    try {
      const found = await projectFor(req, res, true);
      if (!found) return;
      const db = nosqlDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      const { assetId } = req.params;
      if (!(await db.collection('storage_files').findOne({ projectId: found.projectId, fileId: assetId }))) {
        return res.status(404).json({ message: 'Asset not found' });
      }
      const checked = checkRights(req.body);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      res.json({ rights: await saveRights(found.project, assetId, checked.values, found.auth.userId) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // The project's credits sheets, each with its status (as its node shows it).
  router.get('/projects/:projectId/credits-sheets', async (req: Request, res: Response) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      const store = documentStore();
      const sheets = (await store.list(found.projectId)).filter(d => d.kind === 'credits');
      const read = await Promise.all(sheets.map(async summary => {
        const document = await store.get(found.projectId, summary.id);
        if (!document) return null;
        const { rows, status } = await readSheet(found.project, document);
        return { id: document.id, title: document.title, status, rows: rows.length, incomplete: rows.filter(r => r.missing.length).length };
      }));
      res.json({ sheets: read.filter(Boolean) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // A credits sheet: its rows, made now from its sources and its assets' metadata, and its status.
  router.get('/projects/:projectId/credits-sheets/:docId', async (req: Request, res: Response) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      const document = await documentStore().get(found.projectId, req.params.docId);
      if (!document || document.kind !== 'credits') return res.status(404).json({ message: 'Credits sheet not found' });
      res.json(await readSheet(found.project, document));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

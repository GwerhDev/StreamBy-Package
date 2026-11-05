import { Router, Request, Response } from 'express';
import { MongoClient } from 'mongodb';
import { StreamByConfig } from '../../types';
import { canEditProject, isProjectAdmin, isProjectMember } from '../../utils/auth';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { getModel } from '../../models/manager';
import { Auth } from '../../types';
import crypto from 'crypto';
import { deleteDeliverablesOf } from '../../services/deliverables';
import { checkProductionFields, withAssignees } from '../../services/productionFields';
import { teamNotOf } from '../../services/teams';
import {
  addColumn, BoardResult, changeColumn, columnOfCard, deleteColumn, firstColumnOf, orderColumns, readColumns, withColumn,
} from '../../services/productionBoard';
import { cardKey, matchesSearch, nextNumbers, numberCards, readKey, setKey } from '../../services/cardKeys';
import { checkTemplate, createTemplate, deleteTemplate, findTemplate, listTemplates, tasksOf, updateTemplate } from '../../services/taskTemplates';
import { tokenAllows } from '../../services/auth';
import { advanceRuns, cardChanged, deleteRunsOf, TASKS_NODE } from '../../services/pipelineRuns';
import { readLabels, setLabels } from '../../services/productionLabels';
import { callbackBaseOf } from './worker';

function getDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

const SHOT_FIELDS = ['name', 'description', 'status', 'column', 'assignees', 'teams', 'assetId', 'exportId', 'pipelineId', 'dueDate', 'order'] as const;
const TASK_FIELDS = ['name', 'status', 'priority', 'assignees', 'teams', 'dueDate', 'notes', 'stepId'] as const;

const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

// How a shot's tasks go: done of total, the top priority of the open ones, and who they're
// assigned to (people and teams), for a board to find the shot by them.
const summaryOf = (tasks: { status?: string; priority?: string; assignedTo?: unknown; teamIds?: unknown }[]) => {
  const open = tasks.filter(t => t.status !== 'done');
  const priority = open.reduce<string | null>((top, t) =>
    (t.priority && (PRIORITY_RANK[t.priority] ?? 0) > (top ? PRIORITY_RANK[top] : 0) ? t.priority : top), null);
  const assigned = tasks.map(withAssignees);
  return {
    done: tasks.length - open.length, total: tasks.length, priority,
    assignedTo: [...new Set(assigned.flatMap(t => t.assignedTo))],
    teamIds: [...new Set(assigned.flatMap(t => t.teamIds))],
  };
};

// The teams a shot or a task is given, checked to be the project's.
const teamsError = async (projectId: string, values: Record<string, any>) => {
  const unknown = await teamNotOf(projectId, values.teamIds);
  return unknown ? 'teamIds must be a list of teams of the project' : null;
};

// The pipeline a card is given (one of the project's), and the step a task is (a Tasks step of
// its card's pipeline).
const pipelineError = async (projectId: string, values: Record<string, any>) =>
  (values.pipelineId && !(await getDb()!.collection('pipelines').findOne({ id: values.pipelineId, projectId })) ? 'pipelineId must be a pipeline of the project' : null);
const stepError = async (projectId: string, values: Record<string, any>, card: any) => {
  if (!values.stepId) return null;
  const pipeline: any = card?.pipelineId ? await getDb()!.collection('pipelines').findOne({ id: card.pipelineId, projectId }) : null;
  const isStep = (pipeline?.nodeSchema?.nodes ?? []).some((n: any) => n.id === values.stepId && n.type === TASKS_NODE);
  return isStep ? null : "stepId must be a Tasks step of its shot's pipeline";
};

// The column a card is put in, and so its status: the column given (the status given too must
// be its), or the first column of the status given. Null when there's nothing to change.
async function placeCard(projectId: string, values: Record<string, any>, current?: any): Promise<{ columnId: string; status: string } | { error: string } | null> {
  const columns = await readColumns(projectId);
  if (values.columnId !== undefined) {
    const column = columns.find(c => c.id === values.columnId);
    if (!column) return { error: 'columnId must be a column of the board' };
    if (values.status !== undefined && values.status !== column.status) return { error: `status must be the column's (${column.status})` };
    return { columnId: column.id, status: column.status };
  }
  if (values.status === undefined && current) return null;
  const status = values.status ?? 'todo';
  if (current && columnOfCard(columns, current)?.status === status) return null;
  const column = firstColumnOf(columns, status)!;
  return { columnId: column.id, status };
}

// A card as it's answered: in its column, with its status, its people and teams, and its key.
const asCard = (columns: Awaited<ReturnType<typeof readColumns>>, projectKey: string, card: Record<string, any>) => {
  const answered = withColumn(columns, withAssignees(card));
  return { ...answered, key: cardKey(projectKey, answered) };
};

export function productionRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // A card changed in this request: its pipeline's runs go on (and its triggers start one, as
  // whoever changed it, if they may run jobs).
  const afterCardChange = (req: Request, project: any, before: any, after: any) => {
    const auth = (req as any).auth as Auth;
    return cardChanged(project, before, after, auth, tokenAllows(auth.apiToken, 'jobs:run'), callbackBaseOf(req, config))
      .catch(err => console.error('❌ StreamBy pipelines: a card changed:', err?.message ?? err));
  };
  const afterTaskChange = (project: any, shotId: string) =>
    advanceRuns(project, { shotId }).catch(err => console.error('❌ StreamBy pipelines: a task changed:', err?.message ?? err));

  // ── Board ──────────────────────────────────────────────────────────────────

  const projectFor = async (req: Request, res: Response, { edit }: { edit: boolean }) => {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.projectId });
    if (!project) { res.status(404).json({ message: 'Project not found' }); return null; }
    if (!(edit ? canEditProject : isProjectMember)(project, auth.userId)) { res.status(403).json({ message: 'Unauthorized' }); return null; }
    if (!getDb()) { res.status(500).json({ message: 'Database not available' }); return null; }
    return project;
  };
  const answer = (res: Response, result: BoardResult & { moved?: number }) =>
    ('error' in result ? res.status(result.status ?? 400).json({ message: result.error }) : res.json(result));

  // Its columns, in order (a card's status is its column's), and the key its cards' keys start with.
  router.get('/projects/:projectId/production/board', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, { edit: false });
      if (!project) return;
      res.json({
        columns: await readColumns(req.params.projectId), key: await readKey(req.params.projectId, project.name),
        labels: await readLabels(req.params.projectId),
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // The project's card key ({ key }): its admins only. Cards keep their numbers.
  router.put('/projects/:projectId/production/board/key', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, { edit: true });
      if (!project) return;
      if (!isProjectAdmin(project, ((req as any).auth as Auth).userId)) return res.status(403).json({ message: 'Only a project admin can change its key' });
      const result = await setKey(req.params.projectId, req.body?.key);
      if ('error' in result) return res.status(result.status ?? 400).json({ message: result.error });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // What the project calls its sequences and shots ({ sequence, sequences, shot, shots }, any of
  // them; an empty one is the default again): its admins only.
  router.put('/projects/:projectId/production/board/labels', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, { edit: true });
      if (!project) return;
      if (!isProjectAdmin(project, ((req as any).auth as Auth).userId)) return res.status(403).json({ message: 'Only a project admin can change what its sequences and shots are called' });
      const result = await setLabels(req.params.projectId, req.body);
      if ('error' in result) return res.status(result.status ?? 400).json({ message: result.error });
      res.json({ labels: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // The project's cards found by a search (?q=): by key or name, case aside; a key that is the
  // search first. Each with its sequence.
  router.get('/projects/:projectId/production/shots', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, { edit: false });
      if (!project) return;
      const { projectId } = req.params;
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      await numberCards(projectId);
      const [columns, key] = [await readColumns(projectId), await readKey(projectId, project.name)];
      const all = await getDb()!.collection('production_shots').find({ projectId }).sort({ number: 1 }).toArray();
      const found = all.map(sh => asCard(columns, key, sh)).filter(sh => matchesSearch(sh, q));
      const exact = (sh: { key: string | null }) => (sh.key?.toLowerCase() === q.trim().toLowerCase() ? 0 : 1);
      res.json({ shots: found.sort((a, b) => exact(a) - exact(b)) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Its columns in another order ({ order: [every column id] }).
  router.patch('/projects/:projectId/production/board', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      answer(res, await orderColumns(req.params.projectId, req.body?.order));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/board/columns', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      const result = await addColumn(req.params.projectId, req.body);
      if ('error' in result) return answer(res, result);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/board/columns/:columnId', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      answer(res, await changeColumn(req.params.projectId, req.params.columnId, req.body));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // A column deleted: its cards, if any, to the column ?moveTo=<id>.
  router.delete('/projects/:projectId/production/board/columns/:columnId', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      answer(res, await deleteColumn(req.params.projectId, req.params.columnId, req.query.moveTo));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Sequences ──────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/sequences', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const sequences = await db.collection('production_sequences')
        .find({ projectId })
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      res.json({ sequences });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/sequences', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const checked = checkProductionFields(req.body, ['name', 'description', 'order'], project, { creating: true });
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const { values } = checked;

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const now = new Date();
      const sequence = {
        id: crypto.randomUUID(),
        projectId,
        name: values.name,
        description: values.description ?? null,
        order: values.order ?? 0,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('production_sequences').insertOne({ ...sequence });
      res.status(201).json({ sequence });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/sequences/:seqId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const checked = checkProductionFields(req.body, ['name', 'description', 'order'], project);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const $set: Record<string, any> = { ...checked.values, updatedAt: new Date() };

      const result = await db.collection('production_sequences').findOneAndUpdate(
        { id: seqId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Sequence not found' });
      res.json({ sequence: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/sequences/:seqId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      // With its shots, and their tasks and deliverables: nothing is left behind.
      const shotIds = (await db.collection('production_shots').find({ sequenceId: seqId, projectId }).toArray()).map(s => s.id);
      const { deletedCount } = await db.collection('production_sequences').deleteOne({ id: seqId, projectId });
      if (!deletedCount) return res.status(404).json({ message: 'Sequence not found' });
      await db.collection('production_shots').deleteMany({ sequenceId: seqId, projectId });
      if (shotIds.length) await db.collection('production_tasks').deleteMany({ projectId, shotId: { $in: shotIds } });
      await deleteDeliverablesOf(projectId, { shotIds });
      for (const shotId of shotIds) await deleteRunsOf(projectId, { shotId });

      res.json({ message: 'Sequence deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Shots ──────────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/sequences/:seqId/shots', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, seqId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await numberCards(projectId);
      const shots = await db.collection('production_shots')
        .find({ sequenceId: seqId, projectId })
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      // Each shot with how its tasks go, as a board's card shows it: how many are done of how
      // many, and the highest priority among those still open.
      const tasks = shots.length
        ? await db.collection('production_tasks')
          .find({ projectId, shotId: { $in: shots.map(sh => sh.id) } })
          .project({ shotId: 1, status: 1, priority: 1, assignedTo: 1, teamIds: 1 })
          .toArray()
        : [];
      const columns = await readColumns(projectId);
      const key = await readKey(projectId, project.name);
      res.json({ shots: shots.map(sh => ({ ...asCard(columns, key, sh), taskSummary: summaryOf(tasks.filter(t => t.shotId === sh.id)) })) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Cards made in a sequence: each row checked first (none is made if one is wrong, and the answer
  // says which), their numbers taken at once, and a template's tasks given to each, if one is.
  const MAX_CARDS = 200;
  const makeCards = async (req: Request, res: Response, rows: unknown[], { batch }: { batch: boolean }) => {
    const auth = (req as any).auth as Auth;
    const { projectId, seqId } = req.params;
    const project = await Project.findOne({ _id: projectId });
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });
    const db = getDb();
    if (!db) return res.status(500).json({ message: 'Database not available' });

    const rowError = (i: number, message: string) => res.status(400).json({ message: batch ? `Row ${i + 1}: ${message}` : message, ...(batch ? { row: i } : {}) });
    const checkedRows: { values: Record<string, any>; placed: { columnId: string; status: string } }[] = [];
    for (const [i, row] of rows.entries()) {
      const checked = checkProductionFields(row, SHOT_FIELDS, project, { creating: true });
      if ('error' in checked) return rowError(i, checked.error);
      const badTeams = await teamsError(projectId, checked.values);
      if (badTeams) return rowError(i, badTeams);
      const badPipeline = await pipelineError(projectId, checked.values);
      if (badPipeline) return rowError(i, badPipeline);
      const placed = await placeCard(projectId, checked.values);
      if (placed && 'error' in placed) return rowError(i, placed.error);
      checkedRows.push({ values: checked.values, placed: placed! });
    }
    const templateId = (req.body ?? {}).templateId;
    const template = templateId === undefined || templateId === null || templateId === '' ? null : await findTemplate(projectId, templateId);
    if (templateId && !template) return res.status(400).json({ message: 'templateId must be a task template of the project' });
    if (!(await db.collection('production_sequences').findOne({ id: seqId, projectId }))) {
      return res.status(404).json({ message: 'Sequence not found' });
    }

    const numbers = await nextNumbers(projectId, checkedRows.length);
    // A card given no order goes after the sequence's cards, those of its batch in the order given:
    // they're listed by order (then by when they were made, the same for a whole batch).
    const existing = await db.collection('production_shots').find({ projectId, sequenceId: seqId }).project({ order: 1 }).toArray();
    let nextOrder = existing.length ? Math.max(...existing.map((c: any) => (typeof c.order === 'number' ? c.order : 0))) + 1 : 0;
    const orders = checkedRows.map(({ values }) => (values.order !== undefined ? values.order : nextOrder++));
    const now = new Date();
    const shots = checkedRows.map(({ values, placed }, i) => ({
      id: crypto.randomUUID(),
      sequenceId: seqId,
      projectId,
      name: values.name,
      description: values.description ?? null,
      order: orders[i],
      number: numbers[i],
      status: placed.status,
      columnId: placed.columnId,
      assignedTo: values.assignedTo ?? [],
      teamIds: values.teamIds ?? [],
      assetId: values.assetId ?? null,
      exportId: values.exportId ?? null,
      pipelineId: values.pipelineId ?? null,
      dueDate: values.dueDate ?? null,
      createdBy: auth.userId,
      createdAt: now,
      updatedAt: now,
    }));
    for (const shot of shots) {
      await db.collection('production_shots').insertOne({ ...shot });
      const tasks = template ? tasksOf(template, shot, auth.userId) : [];
      for (const task of tasks) await db.collection('production_tasks').insertOne({ ...task });
      await afterCardChange(req, project, null, shot);
    }
    const key = await readKey(projectId, project.name);
    const withKey = (shot: typeof shots[number]) => ({ ...shot, key: cardKey(key, shot) });
    const taskCount = template ? template.tasks.length * shots.length : 0;
    if (batch) return res.status(201).json({ shots: shots.map(withKey), tasks: taskCount });
    return res.status(201).json({ shot: withKey(shots[0]), ...(template ? { tasks: taskCount } : {}) });
  };

  router.post('/projects/:projectId/production/sequences/:seqId/shots', async (req: Request, res: Response) => {
    try {
      await makeCards(req, res, [req.body], { batch: false });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Several cards at once ({ shots: [{ name, description, assignedTo, teamIds, ... }], templateId }).
  router.post('/projects/:projectId/production/sequences/:seqId/shots/batch', async (req: Request, res: Response) => {
    try {
      const rows = req.body?.shots;
      if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CARDS) {
        return res.status(400).json({ message: `shots must be a list of 1 to ${MAX_CARDS} cards` });
      }
      await makeCards(req, res, rows, { batch: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Task templates ───────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/task-templates', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: false }))) return;
      res.json({ templates: await listTemplates(req.params.projectId) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/task-templates', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      const checked = checkTemplate(req.body, { creating: true });
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const template = await createTemplate(req.params.projectId, checked.values as any, ((req as any).auth as Auth).userId);
      res.status(201).json({ template });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/task-templates/:templateId', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      const checked = checkTemplate(req.body);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const template = await updateTemplate(req.params.projectId, req.params.templateId, checked.values);
      if (!template) return res.status(404).json({ message: 'Template not found' });
      res.json({ template });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/task-templates/:templateId', async (req: Request, res: Response) => {
    try {
      if (!(await projectFor(req, res, { edit: true }))) return;
      if (!(await deleteTemplate(req.params.projectId, req.params.templateId))) return res.status(404).json({ message: 'Template not found' });
      res.json({ message: 'Template deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // A template's tasks given to cards of the project ({ shotIds }): each its own.
  router.post('/projects/:projectId/production/task-templates/:templateId/apply', async (req: Request, res: Response) => {
    try {
      const project = await projectFor(req, res, { edit: true });
      if (!project) return;
      const { projectId, templateId } = req.params;
      const shotIds = req.body?.shotIds;
      if (!Array.isArray(shotIds) || !shotIds.length || shotIds.length > MAX_CARDS || !shotIds.every(id => typeof id === 'string' && id)) {
        return res.status(400).json({ message: `shotIds must be a list of 1 to ${MAX_CARDS} card ids` });
      }
      const template = await findTemplate(projectId, templateId);
      if (!template) return res.status(404).json({ message: 'Template not found' });
      const ids = [...new Set(shotIds as string[])];
      const db = getDb()!;
      const cards = await db.collection('production_shots').find({ projectId, id: { $in: ids } }).toArray();
      if (cards.length !== ids.length) return res.status(404).json({ message: 'Every card must be a card of the project' });
      const userId = ((req as any).auth as Auth).userId;
      let count = 0;
      for (const card of cards) {
        const tasks = tasksOf(template, { id: card.id, projectId }, userId);
        for (const task of tasks) await db.collection('production_tasks').insertOne({ ...task });
        count += tasks.length;
        await afterTaskChange(project, card.id);
      }
      res.status(201).json({ tasks: count, shotIds: ids });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/shots/:shotId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const checked = checkProductionFields(req.body, SHOT_FIELDS, project);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const badTeams = await teamsError(projectId, checked.values);
      if (badTeams) return res.status(400).json({ message: badTeams });
      const current = await db.collection('production_shots').findOne({ id: shotId, projectId });
      if (!current) return res.status(404).json({ message: 'Shot not found' });
      const badPipeline = await pipelineError(projectId, checked.values);
      if (badPipeline) return res.status(400).json({ message: badPipeline });
      const placed = await placeCard(projectId, checked.values, current);
      if (placed && 'error' in placed) return res.status(400).json({ message: placed.error });
      const $set: Record<string, any> = { ...checked.values, ...(placed ?? {}), updatedAt: new Date() };

      const result = await db.collection('production_shots').findOneAndUpdate(
        { id: shotId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Shot not found' });
      // Its tasks' steps were its old pipeline's.
      if (checked.values.pipelineId !== undefined && checked.values.pipelineId !== current.pipelineId) {
        await db.collection('production_tasks').updateMany({ projectId, shotId }, { $set: { stepId: null } });
      }
      await afterCardChange(req, project, current, result);
      res.json({ shot: asCard(await readColumns(projectId), await readKey(projectId, project.name), result) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/shots/:shotId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('production_shots').deleteOne({ id: shotId, projectId });
      await db.collection('production_tasks').deleteMany({ shotId, projectId });
      await deleteDeliverablesOf(projectId, { shotIds: [shotId] });
      await deleteRunsOf(projectId, { shotId });

      res.json({ message: 'Shot deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────

  router.get('/projects/:projectId/production/shots/:shotId/tasks', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const tasks = await db.collection('production_tasks')
        .find({ shotId, projectId })
        .sort({ createdAt: 1 })
        .toArray();

      res.json({ tasks: tasks.map(withAssignees) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/production/shots/:shotId/tasks', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const checked = checkProductionFields(req.body, TASK_FIELDS, project, { creating: true });
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const { values } = checked;
      const badTeams = await teamsError(projectId, values);
      if (badTeams) return res.status(400).json({ message: badTeams });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });
      const card = await db.collection('production_shots').findOne({ id: shotId, projectId });
      if (!card) return res.status(404).json({ message: 'Shot not found' });
      const badStep = await stepError(projectId, values, card);
      if (badStep) return res.status(400).json({ message: badStep });

      const now = new Date();
      const task = {
        id: crypto.randomUUID(),
        shotId,
        projectId,
        name: values.name,
        status: values.status ?? 'todo',
        priority: values.priority ?? 'medium',
        assignedTo: values.assignedTo ?? [],
        teamIds: values.teamIds ?? [],
        dueDate: values.dueDate ?? null,
        notes: values.notes ?? null,
        stepId: values.stepId ?? null,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection('production_tasks').insertOne({ ...task });
      await afterTaskChange(project, shotId);
      res.status(201).json({ task });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.patch('/projects/:projectId/production/shots/:shotId/tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId, taskId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      const checked = checkProductionFields(req.body, TASK_FIELDS, project);
      if ('error' in checked) return res.status(400).json({ message: checked.error });
      const badTeams = await teamsError(projectId, checked.values);
      if (badTeams) return res.status(400).json({ message: badTeams });
      const badStep = await stepError(projectId, checked.values, await db.collection('production_shots').findOne({ id: shotId, projectId }));
      if (badStep) return res.status(400).json({ message: badStep });
      const $set: Record<string, any> = { ...checked.values, updatedAt: new Date() };

      const result = await db.collection('production_tasks').findOneAndUpdate(
        { id: taskId, shotId, projectId },
        { $set },
        { returnDocument: 'after' },
      );

      if (!result) return res.status(404).json({ message: 'Task not found' });
      await afterTaskChange(project, shotId);
      res.json({ task: withAssignees(result) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/projects/:projectId/production/shots/:shotId/tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { projectId, shotId, taskId } = req.params;
      const project = await Project.findOne({ _id: projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized' });

      const db = getDb();
      if (!db) return res.status(500).json({ message: 'Database not available' });

      await db.collection('production_tasks').deleteOne({ id: taskId, shotId, projectId });
      await afterTaskChange(project, shotId);
      res.json({ message: 'Task deleted' });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

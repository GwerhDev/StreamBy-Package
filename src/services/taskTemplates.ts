import crypto from 'crypto';
import { nosqlDb } from '../utils/nosqlDb';
import { TASK_PRIORITIES } from './productionFields';

// A project's task templates: a name and its list of tasks (each a name, and a priority and notes
// if given), applied to a card when it's made, or to several cards at once: each gets its own
// tasks, as if made one by one. Changing or deleting a template leaves the tasks it made.

export interface TemplateTask {
  name: string;
  priority: typeof TASK_PRIORITIES[number];
  notes: string | null;
}

export interface TaskTemplate {
  id: string;
  projectId: string;
  name: string;
  tasks: TemplateTask[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_NAME = 100;
const MAX_TASK_NAME = 200;
const MAX_NOTES = 5000;
const MAX_TASKS = 50;

const templates = () => nosqlDb()?.collection<TaskTemplate>('production_task_templates') ?? null;
const strip = ({ _id, ...template }: any): TaskTemplate => template;

type Checked = { values: { name?: string; tasks?: TemplateTask[] } } | { error: string };

/** A template's name and tasks, checked (with `creating`, both required). */
export function checkTemplate(body: any, { creating = false } = {}): Checked {
  const values: { name?: string; tasks?: TemplateTask[] } = {};
  if (creating || body?.name !== undefined) {
    if (typeof body?.name !== 'string' || !body.name.trim()) return { error: 'name must not be blank' };
    if (body.name.trim().length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };
    values.name = body.name.trim();
  }
  if (creating || body?.tasks !== undefined) {
    const tasks = body?.tasks;
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > MAX_TASKS) return { error: `tasks must be a list of 1 to ${MAX_TASKS} tasks` };
    const checked: TemplateTask[] = [];
    for (const [i, task] of tasks.entries()) {
      const name = typeof task === 'string' ? task : task?.name;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_TASK_NAME) {
        return { error: `Task ${i + 1}: its name must not be blank, and at most ${MAX_TASK_NAME} characters` };
      }
      const priority = task?.priority ?? 'medium';
      if (!(TASK_PRIORITIES as readonly unknown[]).includes(priority)) return { error: `Task ${i + 1}: priority must be one of ${TASK_PRIORITIES.join(', ')}` };
      const notes = task?.notes ?? null;
      if (notes !== null && (typeof notes !== 'string' || notes.length > MAX_NOTES)) return { error: `Task ${i + 1}: notes must be text of at most ${MAX_NOTES} characters` };
      checked.push({ name: name.trim(), priority, notes: notes?.trim() ? notes : null });
    }
    values.tasks = checked;
  }
  return { values };
}

/** A project's templates, by name. */
export async function listTemplates(projectId: string): Promise<TaskTemplate[] | null> {
  const col = templates();
  if (!col) return null;
  return (await col.find({ projectId }).sort({ name: 1 }).toArray()).map(strip);
}

export async function findTemplate(projectId: string, id: unknown): Promise<TaskTemplate | null> {
  if (typeof id !== 'string' || !id) return null;
  const found = await templates()?.findOne({ projectId, id });
  return found ? strip(found) : null;
}

export async function createTemplate(projectId: string, values: { name: string; tasks: TemplateTask[] }, userId: string): Promise<TaskTemplate> {
  const now = new Date();
  const template: TaskTemplate = { id: crypto.randomUUID(), projectId, ...values, createdBy: userId, createdAt: now, updatedAt: now };
  await templates()!.insertOne({ ...template });
  return template;
}

export async function updateTemplate(projectId: string, id: string, values: { name?: string; tasks?: TemplateTask[] }): Promise<TaskTemplate | null> {
  const updated = await templates()!.findOneAndUpdate({ projectId, id }, { $set: { ...values, updatedAt: new Date() } }, { returnDocument: 'after' });
  return updated ? strip(updated) : null;
}

export async function deleteTemplate(projectId: string, id: string): Promise<boolean> {
  return ((await templates()?.deleteOne({ projectId, id }))?.deletedCount ?? 0) > 0;
}

/** A deleted project's templates. */
export async function deleteTemplatesOf(projectId: string): Promise<void> {
  if (projectId) await templates()?.deleteMany({ projectId });
}

/** The tasks a template gives a card, as the task routes make them. */
export function tasksOf(template: TaskTemplate, card: { id: string; projectId: string }, userId: string) {
  const now = new Date();
  return template.tasks.map(task => ({
    id: crypto.randomUUID(), shotId: card.id, projectId: card.projectId, name: task.name,
    status: 'todo', priority: task.priority, assignedTo: [] as string[], teamIds: [] as string[],
    dueDate: null, notes: task.notes, stepId: null, templateId: template.id,
    createdBy: userId, createdAt: now, updatedAt: now,
  }));
}

import { activeMemberOf } from '../utils/auth';

// What a production sequence, shot or task may be given, checked before it's saved: a name
// that isn't blank, a known status and priority, assignees who are members of the project (and
// teams, which the route checks are the project's: see checkTeamIdsOf), a due date that is a date.

export const PRODUCTION_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;

const MAX_NAME = 200;
const MAX_TEXT = 5000;

type Field = 'name' | 'description' | 'notes' | 'status' | 'priority' | 'assignees' | 'teams' | 'column' | 'dueDate' | 'order' | 'assetId' | 'exportId' | 'pipelineId' | 'stepId';

export type FieldsResult = { values: Record<string, any> } | { error: string };

/**
 * The fields of `body` that `allowed` lists, checked and ready to save (`assignees` is saved as
 * `assignedTo`, `teams` as `teamIds`). With `creating`, a name is required.
 */
export function checkProductionFields(body: any, allowed: readonly Field[], project: any, { creating = false } = {}): FieldsResult {
  const values: Record<string, any> = {};
  const given = (field: string) => body?.[field] !== undefined;
  const has = (field: Field) => allowed.includes(field);

  if (creating && !given('name')) return { error: 'name is required' };
  if (has('name') && given('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'name must not be blank' };
    if (body.name.trim().length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };
    values.name = body.name.trim();
  }
  for (const field of ['description', 'notes'] as const) {
    if (!has(field) || !given(field)) continue;
    const value = body[field];
    if (value !== null && (typeof value !== 'string' || value.length > MAX_TEXT)) {
      return { error: `${field} must be text of at most ${MAX_TEXT} characters, or null` };
    }
    values[field] = value === null || !value.trim() ? null : value;
  }
  if (has('status') && given('status')) {
    if (!(PRODUCTION_STATUSES as readonly unknown[]).includes(body.status)) return { error: `status must be one of ${PRODUCTION_STATUSES.join(', ')}` };
    values.status = body.status;
  }
  if (has('priority') && given('priority')) {
    if (!(TASK_PRIORITIES as readonly unknown[]).includes(body.priority)) return { error: `priority must be one of ${TASK_PRIORITIES.join(', ')}` };
    values.priority = body.priority;
  }
  const isMember = (id: unknown) => typeof id === 'string' && !!activeMemberOf(project, id);
  if (has('assignees') && given('assignedTo')) {
    const ids = body.assignedTo;
    if (!Array.isArray(ids) || !ids.every(isMember)) return { error: 'assignedTo must be a list of members of the project' };
    values.assignedTo = [...new Set(ids)];
  }
  if (has('column') && given('columnId')) {
    if (typeof body.columnId !== 'string' || !body.columnId) return { error: 'columnId must be a column of the board' };
    values.columnId = body.columnId;
  }
  if (has('teams') && given('teamIds')) {
    const ids = body.teamIds;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id)) return { error: 'teamIds must be a list of teams of the project' };
    values.teamIds = [...new Set(ids)];
  }
  if (has('dueDate') && given('dueDate')) {
    const date = body.dueDate === null || body.dueDate === '' ? null : new Date(body.dueDate);
    if (date && Number.isNaN(date.getTime())) return { error: 'dueDate must be a date, or null' };
    values.dueDate = date;
  }
  if (has('order') && given('order')) {
    if (typeof body.order !== 'number' || !Number.isFinite(body.order)) return { error: 'order must be a number' };
    values.order = body.order;
  }
  for (const field of ['assetId', 'exportId', 'pipelineId', 'stepId'] as const) {
    if (!has(field) || !given(field)) continue;
    if (body[field] !== null && typeof body[field] !== 'string') return { error: `${field} must be an id, or null` };
    values[field] = body[field] || null;
  }
  return { values };
}

// Who a shot or a task is assigned to, as it's answered: people and teams, lists both. (A task
// saved before it could have more than one has its one person, or nobody.)
export function withAssignees<T extends Record<string, any>>(doc: T): T & { assignedTo: string[]; teamIds: string[] } {
  const { assignedTo } = doc;
  return {
    ...doc,
    assignedTo: Array.isArray(assignedTo) ? assignedTo : typeof assignedTo === 'string' && assignedTo ? [assignedTo] : [],
    teamIds: Array.isArray(doc.teamIds) ? doc.teamIds : [],
  };
}

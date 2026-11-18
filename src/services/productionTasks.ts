import crypto from 'crypto';

// A shot's task as it's saved: the values given (checked by the route) and the defaults of
// what isn't. A task made from the Production board and one made from a review note are the same.
export function newTask({ projectId, shotId, userId, values }: {
  projectId: string;
  shotId: string;
  userId: string;
  values: Record<string, any>;
}) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    shotId,
    projectId,
    name: values.name as string,
    status: values.status ?? 'todo',
    priority: values.priority ?? 'medium',
    assignedTo: values.assignedTo ?? [],
    teamIds: values.teamIds ?? [],
    dueDate: values.dueDate ?? null,
    notes: values.notes ?? null,
    stepId: values.stepId ?? null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
}

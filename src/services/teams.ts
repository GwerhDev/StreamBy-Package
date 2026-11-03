import crypto from 'crypto';
import { nosqlDb } from '../utils/nosqlDb';

// A project's teams: groups of its members, to give work to all of them at once. They live in
// the NoSQL database, as its production data does, whatever the project's own database.

export interface Team {
  id: string;
  projectId: string;
  name: string;
  memberIds: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_NAME = 100;

const teams = () => nosqlDb()?.collection<Team>('project_teams') ?? null;

// Who of a project is in it now (an accepted invitation): only they can be in its teams.
const activeMemberIds = (project: any): Set<string> =>
  new Set((project?.members ?? []).filter((m: any) => m.status === 'active').map((m: any) => String(m.userId)));

/** A project's teams, by name, each with only those of its members still in the project. */
export async function listTeams(project: any): Promise<Team[] | null> {
  const col = teams();
  if (!col) return null;
  const projectId = String(project._id ?? project.id);
  const active = activeMemberIds(project);
  const found = await col.find({ projectId }).sort({ name: 1 }).toArray();
  return found.map(({ _id: _omit, ...team }: any) => ({ ...team, memberIds: (team.memberIds ?? []).filter((id: string) => active.has(id)) }));
}

export type TeamChanges = { name?: string; memberIds?: string[] };
type Checked = { values: TeamChanges } | { error: string; status?: number };

/** What a team may be given, checked: a name that isn't blank nor another team's, and members of the project. */
export async function checkTeam(project: any, body: any, { creating = false, teamId }: { creating?: boolean; teamId?: string } = {}): Promise<Checked> {
  const values: TeamChanges = {};
  if (creating && body?.name === undefined) return { error: 'name is required' };
  if (body?.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'name must not be blank' };
    const name = body.name.trim();
    if (name.length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };
    const others = (await listTeams(project)) ?? [];
    if (others.some(t => t.id !== teamId && t.name.toLowerCase() === name.toLowerCase())) {
      return { error: `There's already a team called "${name}"`, status: 409 };
    }
    values.name = name;
  }
  if (body?.memberIds !== undefined) {
    const active = activeMemberIds(project);
    const ids = body.memberIds;
    if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string' && active.has(id))) {
      return { error: 'memberIds must be a list of members of the project' };
    }
    values.memberIds = [...new Set(ids as string[])];
  } else if (creating) {
    values.memberIds = [];
  }
  return { values };
}

export async function createTeam(projectId: string, values: TeamChanges, userId: string): Promise<void> {
  const now = new Date();
  await teams()!.insertOne({
    id: crypto.randomUUID(), projectId, name: values.name!, memberIds: values.memberIds ?? [],
    createdBy: userId, createdAt: now, updatedAt: now,
  });
}

/** Whether the project has that team (it was changed if so). */
export async function updateTeam(projectId: string, teamId: string, values: TeamChanges): Promise<boolean> {
  const result = await teams()!.updateOne({ projectId, id: teamId }, { $set: { ...values, updatedAt: new Date() } });
  return result.matchedCount > 0;
}

/** Whether the project had that team (it's gone if so). */
export async function deleteTeam(projectId: string, teamId: string): Promise<boolean> {
  const result = await teams()!.deleteOne({ projectId, id: teamId });
  return result.deletedCount > 0;
}

/** Someone who's left a project leaves its teams too. */
export async function removeFromTeams(projectId: string, userId: string): Promise<void> {
  const col = teams();
  if (!col) return;
  const theirs = (await col.find({ projectId }).toArray()).filter(t => (t.memberIds ?? []).includes(userId));
  for (const team of theirs) {
    await col.updateOne({ projectId, id: team.id }, { $set: { memberIds: team.memberIds.filter(id => id !== userId), updatedAt: new Date() } });
  }
}

/** A deleted project's teams. */
export async function deleteTeamsOf(projectId: string): Promise<void> {
  if (projectId) await teams()?.deleteMany({ projectId });
}

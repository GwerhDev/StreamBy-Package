import { expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getModel } from '../src/models/manager';

// The routes that list projects, explore them, search users and answer teams, as a SQL and a
// MongoDB database answer them: the same projects (public, private, archived for one member,
// with a pending member), and so the same answers, each asked of the database by what it needs.

export interface Seeded {
  users: Record<'ada' | 'eli' | 'vic', string>;
  projects: Record<'alpha' | 'beta' | 'gamma' | 'delta', string>;
}

export const prefix = (stamp: string) => `bq-${stamp}`;

/** The projects, made as POST /projects/create makes them, in the database of `dbType`. */
export async function seedProjects(dbType: 'sql' | 'nosql', stamp: string, users: Seeded['users']): Promise<Seeded['projects']> {
  const Project = getModel('projects');
  const made = async (name: string, isPublic: boolean | null, members: object[]) => {
    const created: any = await Project.create({
      dbType, name: `${prefix(stamp)}-${name}`, description: '', image: '', allowedOrigin: [], category: null,
      ...(isPublic === null ? {} : { public: isPublic }),
      members, dbConnections: [], storageConnections: [], integrationConnections: [],
    } as any);
    return String(created._id ?? created.id);
  };
  const m = (userId: string, role: string, status = 'active', archived = false) => ({ userId, username: userId, role, status, archived });
  return {
    alpha: await made('alpha', true, [m(users.ada, 'admin'), m(users.eli, 'editor', 'active', true)]),
    beta: await made('beta', false, [m(users.ada, 'admin'), m(users.vic, 'viewer', 'pending')]),
    gamma: await made('gamma', true, [m(users.vic, 'admin'), m(users.eli, 'viewer', 'pending')]),
    delta: await made('delta', null, [m(users.eli, 'viewer')]),
  };
}

const byName = (list: any[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

/** Runs the scenario against an app made with StreamBy's router (its auth: the x-test-user header). */
export async function runScenario(app: express.Express, stamp: string, { users, projects }: Seeded) {
  const as = (user: string) => ({
    get: (p: string) => request(app).get(`/streamby${p}`).set('x-test-user', user),
    post: (p: string, body?: object) => request(app).post(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
    patch: (p: string, body?: object) => request(app).patch(`/streamby${p}`).set('x-test-user', user).send(body ?? {}),
    delete: (p: string) => request(app).delete(`/streamby${p}`).set('x-test-user', user),
  });
  const ada = as(users.ada);
  const eli = as(users.eli);
  const vic = as(users.vic);
  const P = prefix(stamp);
  // Only this scenario's projects: a local database may have others.
  const ours = (list: any[]) => byName(list.filter((p: any) => String(p.name).startsWith(P)));
  const listed = async (who: ReturnType<typeof as>, query = '') => ours((await who.get(`/projects${query}`)).body.projects);
  const card = (key: keyof Seeded['projects'], archived = false) =>
    expect.objectContaining({ id: projects[key], name: `${P}-${key}`, image: '', archived });

  // A member's projects: those they're an active member of, archived or not for them.
  expect(await listed(ada)).toEqual([card('alpha'), card('beta')]);
  expect(await listed(eli)).toEqual([card('alpha', true), card('delta')]);
  expect(await listed(eli, '?archived=true')).toEqual([card('alpha', true)]);
  expect(await listed(eli, '?archived=false')).toEqual([card('delta')]);
  // A pending invitation isn't one yet.
  expect(await listed(vic)).toEqual([card('gamma')]);

  // Exploring: all but the private ones, each with its members and whether one is in it.
  const explored = ours((await eli.get('/projects/explore')).body.projects);
  expect(explored).toEqual([
    { id: projects.alpha, name: `${P}-alpha`, description: '', image: '', memberCount: 2, isMember: true, hasPendingRequest: false },
    { id: projects.delta, name: `${P}-delta`, description: '', image: '', memberCount: 1, isMember: true, hasPendingRequest: false },
    { id: projects.gamma, name: `${P}-gamma`, description: '', image: '', memberCount: 1, isMember: false, hasPendingRequest: true },
  ]);

  // The routes that change a project answer the user's projects as they are then.
  const patched = await ada.patch(`/projects/${projects.beta}`, { description: 'Changed' });
  expect(patched.status).toBe(200);
  expect(ours(patched.body.projects)).toEqual([card('alpha'), card('beta')]);
  const archived = await eli.patch(`/projects/${projects.delta}/archive`);
  expect(ours(archived.body.projects)).toEqual([card('alpha', true), card('delta', true)]);
  const unarchived = await eli.patch(`/projects/${projects.alpha}/unarchive`);
  expect(ours(unarchived.body.projects)).toEqual([card('alpha'), card('delta', true)]);
  const created = await vic.post('/projects/create', { name: `${P}-epsilon` });
  expect(created.status).toBe(200);
  expect(ours(created.body.projects).map((p: any) => p.name)).toEqual([`${P}-epsilon`, `${P}-gamma`]);
  const deleted = await ada.delete(`/projects/${projects.beta}`);
  expect(deleted.status).toBe(200);
  expect(ours(deleted.body.projects)).toEqual([card('alpha')]);

  // A team's members, with their usernames.
  const team = await ada.post(`/projects/${projects.alpha}/teams`, { name: 'Artists', memberIds: [users.ada, users.eli] });
  expect(team.status).toBe(201);
  const teams = (await eli.get(`/projects/${projects.alpha}/teams`)).body.teams;
  expect(teams.map((t: any) => t.members.map((m: any) => m.username).sort())).toEqual([[`${P}-ada`, `${P}-eli`]]);

  // Users found by a part of their username, case aside; what's searched taken as it is.
  const search = async (q: string) => (await ada.get(`/users/search?q=${encodeURIComponent(q)}`)).body.users.map((u: any) => u.username).sort();
  expect(await search(`${P.toUpperCase()}-A`)).toEqual([`${P}-ada`]);
  expect(await search(`${P}-`)).toEqual([`${P}-ada`, `${P}-eli`, `${P}-vic`]);
  expect(await search(`${P}%`)).toEqual([]);
  expect(await search(`${P}.`)).toEqual([]);
  expect((await ada.get(`/users/search?q=${encodeURIComponent(`${P}-`)}`)).body.users[0]).toEqual({ id: expect.any(String), username: expect.stringMatching(new RegExp(`^${P}-`)), profilePic: '' });
}

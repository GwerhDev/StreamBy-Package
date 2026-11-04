import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { FakeDb } from './fakeMongo';
import { runScenario, seedProjects, prefix } from './boundedQueriesScenario';

// The routes that list projects, explore them, search users and answer teams, against a MongoDB
// database (here in memory) through the models as they are: each asks the database for what it
// needs, never for all its projects or users.
const mongo = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/database/connectionManager')>()),
  initConnections: async () => {},
  getConnectedIds: () => ['mongo'],
  getConnection: () => ({ type: 'nosql', client: { db: () => mongo.db } }),
}));
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));
// Plans are another's concern: everyone here is a subscriber.
vi.mock('../src/middleware/routes/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/routes/subscription')>()),
  ensureSubscription: (req: any, _res: any, next: any) => { req.subscription = 'subscriber'; next(); },
}));

const { createStreamByRouter } = await import('../src/middleware/createRouter');
const { Model } = await import('../src/models/Model');
const { getModel } = await import('../src/models/manager');

const app = express();
app.use(express.json());
app.use('/streamby', createStreamByRouter({
  storageProviders: [], adapter: {} as any, databases: [{ id: 'mongo', type: 'nosql', main: true }],
  authProvider: async (req: any) => {
    const user = req.headers['x-test-user'];
    if (!user) throw new Error('No session');
    return { userId: user, username: user, role: 'viewer' as const };
  },
}));

const STAMP = 'mongo';
const seedUsers = () => {
  const users = Object.fromEntries((['ada', 'eli', 'vic'] as const).map(name => [name, new ObjectId()])) as Record<'ada' | 'eli' | 'vic', ObjectId>;
  for (const [name, _id] of Object.entries(users)) mongo.db.collection('users').docs.push({ _id, username: `${prefix(STAMP)}-${name}` });
  return Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.toHexString()])) as Record<'ada' | 'eli' | 'vic', string>;
};

let finds: any[] = [];
beforeEach(() => {
  mongo.db = new FakeDb();
  finds = [];
  const find = Model.prototype.find;
  vi.spyOn(Model.prototype, 'find').mockImplementation(function (this: any, filter: any, options?: any) {
    finds.push({ table: this.getTableName(), filter });
    return find.call(this, filter, options);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('in MongoDB', () => {
  it('lists, explores, changes projects, searches users and answers teams as before', async () => {
    const users = seedUsers();
    const projects = await seedProjects('nosql', STAMP, users);
    await runScenario(app, STAMP, { users, projects });
  });

  it('never reads every project or user to answer a request', async () => {
    const users = seedUsers();
    const projects = await seedProjects('nosql', STAMP, users);
    finds = [];
    await runScenario(app, STAMP, { users, projects });
    expect(finds.length).toBeGreaterThan(0);
    expect(finds.filter(f => !Object.keys(f.filter ?? {}).length)).toEqual([]);
  });

  it("finds a member's projects by an id kept as an ObjectId too, as older projects keep it", async () => {
    const id = new ObjectId();
    mongo.db.collection('projects').docs.push({ _id: new ObjectId(), name: 'Old', members: [{ userId: id, role: 'admin', status: 'active' }] });
    const found = await getModel('projects').find({ memberUserId: id.toHexString() });
    expect(found.map((p: any) => p.name)).toEqual(['Old']);
  });

  it('caps a search at 20 users', async () => {
    for (let i = 0; i < 25; i++) mongo.db.collection('users').docs.push({ _id: new ObjectId(), username: `many-${i}` });
    const res = await request(app).get('/streamby/users/search?q=MANY').set('x-test-user', 'someone');
    expect(res.body.users).toHaveLength(20);
  });
});

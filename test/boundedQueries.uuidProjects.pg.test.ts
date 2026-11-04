import { vi } from 'vitest';
import { FakeDb } from './fakeMongo';
import { pgSuite } from './boundedQueriesPg';

// A database whose projects' ids are uuid, and its members' "projectId" text (as an older
// StreamBy's, migrated halfway, keeps them).
// Teams live in the NoSQL database: here in memory, beside the local PostgreSQL.
const nosql = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/adapters/database/connectionManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/adapters/database/connectionManager')>();
  return {
    ...original,
    getConnectedIds: () => [...original.getConnectedIds(), 'teams-nosql'],
    getConnection: (id: string) => (id === 'teams-nosql' ? { id, type: 'nosql', client: { db: () => nosql.db } } : original.getConnection(id)),
  };
});
vi.mock('../src/services/backfillBuiltinConnections', () => ({ backfillBuiltinConnections: async () => {} }));
vi.mock('../src/services/wsHub', () => ({ initWsHub: () => {}, emitToUser: () => {} }));
vi.mock('../src/middleware/routes/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/routes/subscription')>()),
  ensureSubscription: (req: any, _res: any, next: any) => { req.subscription = 'subscriber'; next(); },
}));
nosql.db = new FakeDb();

pgSuite({ name: 'uuid projects', projectId: 'uuid', memberProjectId: 'text' });

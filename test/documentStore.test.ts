import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { FakeDb } from './fakeMongo';
import { DocumentAuthor } from '../src/types';

// The MongoDB store, with the main database a (fake) MongoDB.
const mongo = vi.hoisted(() => ({ db: null as any, startSession: undefined as undefined | (() => any) }));
vi.mock('../src/adapters/database/connectionManager', () => ({
  getConnectedIds: () => ['mongo'],
  getConnection: () => ({ type: 'nosql', client: { db: () => mongo.db, ...(mongo.startSession ? { startSession: mongo.startSession } : {}) } }),
}));

const { documentStore, setDocumentStoreDatabase } = await import('../src/services/documents');
setDocumentStoreDatabase({ databases: [{ id: 'mongo', type: 'nosql', main: true }] } as any);

const ada: DocumentAuthor = { userId: 'ada', username: 'ada', via: 'session' };
const newDocument = () => {
  const now = new Date();
  return {
    id: crypto.randomUUID(), projectId: 'p1', kind: 'document' as const, title: 'Architecture', parentId: null, position: 0,
    content: 'v1', version: 1, exportable: false, publishedVersion: null, createdAt: now, createdBy: ada, updatedAt: now, updatedBy: ada,
  };
};

beforeEach(() => { mongo.db = new FakeDb(); mongo.startSession = undefined; });

describe('documents in MongoDB', () => {
  it('keeps them in their own collections, without the driver\'s _id', async () => {
    const doc = await documentStore().create(newDocument());
    expect(mongo.db.docs('documents')).toHaveLength(1);
    expect(mongo.db.docs('document_versions')).toEqual([expect.objectContaining({ documentId: doc.id, version: 1, content: 'v1' })]);
    expect(await documentStore().get('p1', doc.id)).not.toHaveProperty('_id');
    expect(await documentStore().get('p2', doc.id)).toBeNull();
  });

  it('saves a version only on the latest one', async () => {
    const doc = await documentStore().create(newDocument());
    const saved = await documentStore().save('p1', doc.id, 1, { title: 'Architecture', content: 'v2' }, ada, new Date());
    expect(saved).toMatchObject({ version: 2, content: 'v2' });
    expect(await documentStore().save('p1', doc.id, 1, { title: 'Architecture', content: 'late' }, ada, new Date())).toBeNull();
    expect((await documentStore().versions('p1', doc.id)).map(v => v.version)).toEqual([2, 1]);
  });

  it('removes documents with their versions', async () => {
    const doc = await documentStore().create(newDocument());
    await documentStore().remove('p1', [doc.id]);
    expect(mongo.db.docs('documents')).toEqual([]);
    expect(mongo.db.docs('document_versions')).toEqual([]);
  });
});

describe('a save in MongoDB', () => {
  // Each write says the session it's part of: the fake only records it.
  const recordSessions = () => {
    const seen: unknown[] = [];
    for (const name of ['documents', 'document_versions']) {
      const col = mongo.db.collection(name);
      for (const op of ['insertOne', 'findOneAndUpdate', 'deleteMany'] as const) {
        const original = col[op].bind(col);
        col[op] = (...args: any[]) => { seen.push(args[args.length - 1]?.session); return original(...args); };
      }
    }
    return seen;
  };

  // A standalone server has no transactions: the two writes go as they are, and it's remembered.
  it("still saves on a server without transactions, and stops asking for them", async () => {
    vi.resetModules();
    const fresh = await import('../src/services/documents');
    fresh.setDocumentStoreDatabase({ databases: [{ id: 'mongo', type: 'nosql', main: true }] } as any);
    const startSession = vi.fn(() => ({
      withTransaction: async () => { throw Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 }); },
      endSession: async () => {},
    }));
    mongo.startSession = startSession;
    const doc = await fresh.documentStore().create(newDocument());
    expect(await fresh.documentStore().save('p1', doc.id, 1, { title: 'Architecture', content: 'v2' }, ada, new Date())).toMatchObject({ version: 2 });
    expect((await fresh.documentStore().versions('p1', doc.id)).map(v => v.version)).toEqual([2, 1]);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('writes the document and its version in one transaction, when the server has them', async () => {
    const session = { withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()), endSession: vi.fn(async () => {}) };
    mongo.startSession = () => session;
    const seen = recordSessions();
    const doc = await documentStore().create(newDocument());
    await documentStore().save('p1', doc.id, 1, { title: 'Architecture', content: 'v2' }, ada, new Date());
    expect(session.withTransaction).toHaveBeenCalledTimes(2);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(s => s === session)).toBe(true);
    expect(session.endSession).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { FakeDb } from './fakeMongo';
import { DocumentAuthor } from '../src/types';

// The MongoDB store, with the main database a (fake) MongoDB.
const mongo = vi.hoisted(() => ({ db: null as any }));
vi.mock('../src/adapters/database/connectionManager', () => ({
  getConnectedIds: () => ['mongo'],
  getConnection: () => ({ type: 'nosql', client: { db: () => mongo.db } }),
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

beforeEach(() => { mongo.db = new FakeDb(); });

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

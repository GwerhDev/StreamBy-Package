import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Pool } from 'pg';
import { initConnections, getConnection } from '../src/adapters/database/connectionManager';
import { documentStore, setDocumentStoreDatabase, publishedDocuments } from '../src/services/documents';
import { DocumentAuthor } from '../src/types';

// Against a local PostgreSQL (as pg.test.ts): documents and versions as the main database keeps them.
const connectionString = 'postgresql://postgres:postgres@localhost:5432/postgres';
const config: any = { storageProviders: [], authProvider: async () => ({}), databases: [{ id: 'pg-docs', type: 'sql', main: true, connectionString }] };
const PROJECT = `test-docs-${Date.now()}`;
const ada: DocumentAuthor = { userId: 'ada', username: 'ada', via: 'session' };
const claude: DocumentAuthor = { userId: 'ada', username: 'ada', via: 'oauth', clientId: 'dyn_1', clientName: 'Claude' };

const newDocument = (over: object = {}) => {
  const now = new Date();
  return {
    id: crypto.randomUUID(), projectId: PROJECT, kind: 'document' as const, title: 'Architecture', parentId: null, position: 0,
    content: '## Storage\n', version: 1, exportable: false, publishedVersion: null,
    createdAt: now, createdBy: ada, updatedAt: now, updatedBy: ada, ...over,
  };
};

describe('documents in PostgreSQL', () => {
  beforeAll(async () => {
    await initConnections(config.databases);
    setDocumentStoreDatabase(config);
  });

  afterAll(async () => {
    await documentStore().deleteProject(PROJECT);
    const pool = getConnection('pg-docs').client as Pool;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM streamby.document_versions WHERE "projectId" = $1', [PROJECT]);
    expect(rows[0].n).toBe(0);
  });

  it('keeps a document, its first version and its author, as given', async () => {
    const doc = await documentStore().create(newDocument());
    expect(doc).toMatchObject({ title: 'Architecture', version: 1, createdBy: ada });
    expect((await documentStore().list(PROJECT)).find(d => d.id === doc.id)).not.toHaveProperty('content');
    const [first] = await documentStore().versions(PROJECT, doc.id);
    expect(first).toMatchObject({ version: 1, author: ada });
    expect((await documentStore().version(PROJECT, doc.id, 1))!.content).toBe('## Storage\n');
  });

  it('saves only one of several versions made on the same one, and keeps each save', async () => {
    const doc = await documentStore().create(newDocument());
    const saves = await Promise.all(['a', 'b', 'c', 'd'].map(text =>
      documentStore().save(PROJECT, doc.id, 1, { title: 'Architecture', content: text }, claude, new Date())));
    const won = saves.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ version: 2, updatedBy: claude });
    expect((await documentStore().versions(PROJECT, doc.id)).map(v => v.version)).toEqual([2, 1]);
  });

  it('delivers the published version, and removes a document with its versions', async () => {
    const doc = await documentStore().create(newDocument({ content: 'published' }));
    await documentStore().save(PROJECT, doc.id, 1, { title: 'Architecture', content: 'draft' }, ada, new Date());
    await documentStore().update(PROJECT, doc.id, { exportable: true, publishedVersion: 1 });
    expect((await publishedDocuments(PROJECT)).find(d => d.id === doc.id)).toMatchObject({ version: 1, content: 'published' });

    await documentStore().remove(PROJECT, [doc.id]);
    expect(await documentStore().get(PROJECT, doc.id)).toBeNull();
    expect(await documentStore().versions(PROJECT, doc.id)).toEqual([]);
  });
});

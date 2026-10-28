import { Pool } from 'pg';
import { ClientSession, MongoClient } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { Auth, DocumentAuthor, DocumentVersion, ProjectDocument, StreamByConfig } from '../types';

// A project's documents (its concept, its architecture...): markdown its team reads and edits,
// and agents read and keep up to date. Kept in the main database, like jobs (`streamby.documents`
// and `streamby.document_versions` in PostgreSQL, two collections in MongoDB), in memory without
// one. Every save is a version, and only goes through if the document is still at the version
// it was made on: a change made in between is never overwritten without notice.

/** A document as the tree lists it: all but its content. */
export type DocumentSummary = Omit<ProjectDocument, 'content'>;
/** A version as the history lists it: all but its content. */
export type VersionSummary = Omit<DocumentVersion, 'content'>;

type Structure = Partial<Pick<ProjectDocument, 'parentId' | 'position' | 'exportable' | 'publishedVersion'>>;

export interface DocumentStore {
  list(projectId: string): Promise<DocumentSummary[]>;
  get(projectId: string, id: string): Promise<ProjectDocument | null>;
  /** A new document, and its first version. */
  create(document: ProjectDocument): Promise<ProjectDocument>;
  /**
   * A new version, only if the document is still at `baseVersion`: null if it isn't (someone
   * saved in between) or there's no such document.
   */
  save(projectId: string, id: string, baseVersion: number, change: { title: string; content: string }, author: DocumentAuthor, at: Date): Promise<ProjectDocument | null>;
  /** Where it is in the tree, and what's published of it: not a version. */
  update(projectId: string, id: string, patch: Structure): Promise<ProjectDocument | null>;
  /** Its versions, the latest first. */
  versions(projectId: string, id: string): Promise<VersionSummary[]>;
  version(projectId: string, id: string, version: number): Promise<DocumentVersion | null>;
  /** Documents and their versions. */
  remove(projectId: string, ids: string[]): Promise<void>;
  /** A deleted project's documents. */
  deleteProject(projectId: string): Promise<void>;
}

const withoutContent = <T extends { content: string }>({ content: _content, ...rest }: T): Omit<T, 'content'> => rest;
const byPlace = (a: DocumentSummary, b: DocumentSummary) =>
  a.position - b.position || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

// ── PostgreSQL ──

const sqlStore = (pool: Pool): DocumentStore => {
  const DOCS = 'streamby.documents';
  const VERSIONS = 'streamby.document_versions';
  const SUMMARY = `id, "projectId", kind, title, "parentId", position, version, exportable, "publishedVersion", "createdAt", "createdBy", "updatedAt", "updatedBy"`;
  const insertVersion = (client: Pool | import('pg').PoolClient, v: DocumentVersion) => client.query(
    `INSERT INTO ${VERSIONS} ("documentId", "projectId", version, title, content, author, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [v.documentId, v.projectId, v.version, v.title, v.content, JSON.stringify(v.author), v.createdAt],
  );
  // A save changes two tables: both, or neither.
  const transaction = async <T>(work: (client: import('pg').PoolClient) => Promise<T | null>): Promise<T | null> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query(result === null ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  return {
    async list(projectId) {
      const { rows } = await pool.query(`SELECT ${SUMMARY} FROM ${DOCS} WHERE "projectId" = $1 ORDER BY position, "createdAt"`, [projectId]);
      return rows;
    },
    async get(projectId, id) {
      const { rows } = await pool.query(`SELECT * FROM ${DOCS} WHERE "projectId" = $1 AND id = $2`, [projectId, id]);
      return rows[0] ?? null;
    },
    async create(d) {
      return (await transaction(async client => {
        const { rows } = await client.query(
          `INSERT INTO ${DOCS} (id, "projectId", kind, title, "parentId", position, content, version, exportable, "publishedVersion", "createdAt", "createdBy", "updatedAt", "updatedBy")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [d.id, d.projectId, d.kind, d.title, d.parentId, d.position, d.content, d.version, d.exportable, d.publishedVersion,
            d.createdAt, JSON.stringify(d.createdBy), d.updatedAt, JSON.stringify(d.updatedBy)],
        );
        await insertVersion(client, { documentId: d.id, projectId: d.projectId, version: d.version, title: d.title, content: d.content, author: d.createdBy, createdAt: d.createdAt });
        return rows[0] as ProjectDocument;
      }))!;
    },
    async save(projectId, id, baseVersion, change, author, at) {
      return transaction(async client => {
        const { rows } = await client.query(
          `UPDATE ${DOCS} SET title = $4, content = $5, version = version + 1, "updatedAt" = $6, "updatedBy" = $7
            WHERE "projectId" = $1 AND id = $2 AND version = $3 RETURNING *`,
          [projectId, id, baseVersion, change.title, change.content, at, JSON.stringify(author)],
        );
        const saved = rows[0] as ProjectDocument | undefined;
        if (!saved) return null;
        await insertVersion(client, { documentId: id, projectId, version: saved.version, title: saved.title, content: saved.content, author, createdAt: at });
        return saved;
      });
    },
    async update(projectId, id, patch) {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (!entries.length) return this.get(projectId, id);
      const sets = entries.map(([key], i) => `"${key}" = $${i + 3}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE ${DOCS} SET ${sets} WHERE "projectId" = $1 AND id = $2 RETURNING *`,
        [projectId, id, ...entries.map(([, value]) => value)],
      );
      return rows[0] ?? null;
    },
    async versions(projectId, id) {
      const { rows } = await pool.query(
        `SELECT "documentId", "projectId", version, title, author, "createdAt" FROM ${VERSIONS}
          WHERE "projectId" = $1 AND "documentId" = $2 ORDER BY version DESC`,
        [projectId, id],
      );
      return rows;
    },
    async version(projectId, id, version) {
      const { rows } = await pool.query(
        `SELECT * FROM ${VERSIONS} WHERE "projectId" = $1 AND "documentId" = $2 AND version = $3`,
        [projectId, id, version],
      );
      return rows[0] ?? null;
    },
    async remove(projectId, ids) {
      if (!ids.length) return;
      await transaction(async client => {
        await client.query(`DELETE FROM ${VERSIONS} WHERE "projectId" = $1 AND "documentId" = ANY($2)`, [projectId, ids]);
        await client.query(`DELETE FROM ${DOCS} WHERE "projectId" = $1 AND id = ANY($2)`, [projectId, ids]);
        return true;
      });
    },
    async deleteProject(projectId) {
      await pool.query(`DELETE FROM ${VERSIONS} WHERE "projectId" = $1`, [projectId]);
      await pool.query(`DELETE FROM ${DOCS} WHERE "projectId" = $1`, [projectId]);
    },
  };
};

// ── MongoDB ──

// A save writes the document and then its version: in a transaction, both or neither, when
// the server supports them (a replica set or a sharded cluster, as Atlas is). A standalone
// server doesn't: there they're two writes, and if the version's failed after the document's,
// the document would be at a version its history lacks.
let mongoTransactions: boolean | undefined;
const noTransactions = (err: unknown) => {
  const { code, message } = (err ?? {}) as { code?: number; message?: string };
  return code === 20 || /Transaction numbers are only allowed|replica set/i.test(message ?? '');
};

const mongoStore = (client: MongoClient): DocumentStore => {
  const docs = () => client.db().collection('documents');
  const versions = () => client.db().collection('document_versions');
  const strip = <T>(doc: any): T | null => {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest as T;
  };
  const together = async <T>(work: (session?: ClientSession) => Promise<T>): Promise<T> => {
    if (mongoTransactions !== false && typeof client.startSession === 'function') {
      const session = client.startSession();
      try {
        let result!: T;
        await session.withTransaction(async () => { result = await work(session); });
        mongoTransactions = true;
        return result;
      } catch (err) {
        if (!noTransactions(err)) throw err;
        mongoTransactions = false;
      } finally {
        await session.endSession();
      }
    }
    return work();
  };
  return {
    async list(projectId) {
      const found = await docs().find({ projectId }, { projection: { content: 0 } }).toArray();
      return found.map(d => strip<DocumentSummary>(d)!).sort(byPlace);
    },
    async get(projectId, id) {
      return strip<ProjectDocument>(await docs().findOne({ projectId, id }));
    },
    async create(d) {
      return together(async session => {
        await docs().insertOne({ ...d }, { session });
        await versions().insertOne({ documentId: d.id, projectId: d.projectId, version: d.version, title: d.title, content: d.content, author: d.createdBy, createdAt: d.createdAt }, { session });
        return d;
      });
    },
    async save(projectId, id, baseVersion, change, author, at) {
      return together(async session => {
        // Conditional on the version: of two saves made on the same one, only the first goes through.
        const saved = strip<ProjectDocument>(await docs().findOneAndUpdate(
          { projectId, id, version: baseVersion },
          { $set: { ...change, version: baseVersion + 1, updatedAt: at, updatedBy: author } },
          { returnDocument: 'after', session },
        ));
        if (!saved) return null;
        await versions().insertOne({ documentId: id, projectId, version: saved.version, ...change, author, createdAt: at }, { session });
        return saved;
      });
    },
    async update(projectId, id, patch) {
      const $set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      if (!Object.keys($set).length) return this.get(projectId, id);
      return strip<ProjectDocument>(await docs().findOneAndUpdate({ projectId, id }, { $set }, { returnDocument: 'after' }));
    },
    async versions(projectId, id) {
      const found = await versions().find({ projectId, documentId: id }, { projection: { content: 0 } }).toArray();
      return found.map(v => strip<VersionSummary>(v)!).sort((a, b) => b.version - a.version);
    },
    async version(projectId, id, version) {
      return strip<DocumentVersion>(await versions().findOne({ projectId, documentId: id, version }));
    },
    async remove(projectId, ids) {
      if (!ids.length) return;
      await together(async session => {
        await versions().deleteMany({ projectId, documentId: { $in: ids } }, { session });
        await docs().deleteMany({ projectId, id: { $in: ids } }, { session });
      });
    },
    async deleteProject(projectId) {
      await versions().deleteMany({ projectId });
      await docs().deleteMany({ projectId });
    },
  };
};

// ── In memory (no main database) ──

const memoryStore = (): DocumentStore => {
  const docs = new Map<string, ProjectDocument>();
  const versions: DocumentVersion[] = [];
  const own = (projectId: string, id: string) => {
    const d = docs.get(id);
    return d && d.projectId === projectId ? d : undefined;
  };
  return {
    async list(projectId) {
      return [...docs.values()].filter(d => d.projectId === projectId).map(withoutContent).sort(byPlace);
    },
    async get(projectId, id) {
      const d = own(projectId, id);
      return d ? { ...d } : null;
    },
    async create(d) {
      docs.set(d.id, { ...d });
      versions.push({ documentId: d.id, projectId: d.projectId, version: d.version, title: d.title, content: d.content, author: d.createdBy, createdAt: d.createdAt });
      return { ...d };
    },
    async save(projectId, id, baseVersion, change, author, at) {
      const d = own(projectId, id);
      if (!d || d.version !== baseVersion) return null;
      Object.assign(d, change, { version: baseVersion + 1, updatedAt: at, updatedBy: author });
      versions.push({ documentId: id, projectId, version: d.version, ...change, author, createdAt: at });
      return { ...d };
    },
    async update(projectId, id, patch) {
      const d = own(projectId, id);
      if (!d) return null;
      Object.assign(d, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
      return { ...d };
    },
    async versions(projectId, id) {
      return versions.filter(v => v.projectId === projectId && v.documentId === id).map(withoutContent).sort((a, b) => b.version - a.version);
    },
    async version(projectId, id, version) {
      const v = versions.find(x => x.projectId === projectId && x.documentId === id && x.version === version);
      return v ? { ...v } : null;
    },
    async remove(projectId, ids) {
      for (const id of ids) if (own(projectId, id)) docs.delete(id);
      for (let i = versions.length - 1; i >= 0; i--) if (versions[i].projectId === projectId && ids.includes(versions[i].documentId)) versions.splice(i, 1);
    },
    async deleteProject(projectId) {
      for (const [id, d] of docs) if (d.projectId === projectId) docs.delete(id);
      for (let i = versions.length - 1; i >= 0; i--) if (versions[i].projectId === projectId) versions.splice(i, 1);
    },
  };
};

let mainDbId: string | undefined;
let memory: DocumentStore | undefined;

/** The router's main database, where documents are kept. */
export const setDocumentStoreDatabase = (config: StreamByConfig) => {
  mainDbId = config.databases?.find(db => db.main)?.id;
};

export function documentStore(): DocumentStore {
  if (mainDbId && getConnectedIds().includes(mainDbId)) {
    const entry = getConnection(mainDbId);
    return entry.type === 'sql' ? sqlStore(entry.client as Pool) : mongoStore(entry.client as MongoClient);
  }
  return (memory ??= memoryStore());
}

// ── Who saved it ──

/** Who's saving: the user, through the UI, an API token, or an app acting for them. */
export function authorOf(auth: Auth): DocumentAuthor {
  if (auth.oauth) return { userId: auth.userId, username: auth.username, via: 'oauth', clientId: auth.oauth.clientId, clientName: auth.oauth.clientName };
  if (auth.apiToken) return { userId: auth.userId, username: auth.username, via: 'apiToken', tokenId: auth.apiToken.tokenId };
  return { userId: auth.userId, username: auth.username, via: 'session' };
}

// ── The tree ──

/** A document and everything inside it (a folder's documents, at any depth). */
export function withDescendants(documents: DocumentSummary[], id: string): string[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    for (const d of documents) if (d.parentId === ids[i]) ids.push(d.id);
  }
  return ids;
}

// ── Sections ──

// A section is what's under a markdown heading ("## Architecture"), up to the next heading of
// the same level or above. Headings inside a fenced code block aren't headings.
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

const headingOf = (text: string) => {
  const match = text.trim().match(/^(#{1,6})[ \t]+(.*?)[ \t]*#*$/);
  return match ? { level: match[1].length, title: match[2].trim() } : { level: null, title: text.trim() };
};

export type SectionResult = { content: string } | { error: 'not-found' | 'ambiguous' };

/**
 * The markdown with what's under `heading` replaced by `body`, the rest untouched. `heading` is
 * its title, with or without its #s ("## Architecture", "Architecture"): with them, only a
 * heading of that level matches.
 */
export function replaceSection(markdown: string, heading: string, body: string): SectionResult {
  const wanted = headingOf(heading);
  const lines = markdown.split('\n');
  const headings: { line: number; level: number; title: string }[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    const match = !fenced && line.match(HEADING);
    if (match) headings.push({ line: i, level: match[1].length, title: match[2].trim() });
  });

  const matches = headings.filter(h => h.title === wanted.title && (wanted.level === null || h.level === wanted.level));
  if (!matches.length) return { error: 'not-found' };
  if (matches.length > 1) return { error: 'ambiguous' };

  const [target] = matches;
  const next = headings.find(h => h.line > target.line && h.level <= target.level);
  const end = next ? next.line : lines.length;
  const text = body.replace(/^(\s*\n)+/, '').replace(/\s+$/, '');
  const replaced = [
    ...lines.slice(0, target.line + 1),
    ...(text ? ['', ...text.split('\n')] : []),
    ...(next ? [''] : []),
    ...lines.slice(end),
  ];
  // A document's last line ends it, as it did.
  if (!next && markdown.endsWith('\n')) replaced.push('');
  return { content: replaced.join('\n') };
}

// ── Published ──

/** A document as an export delivers it: its published version, never a draft. */
export interface PublishedDocument {
  id: string;
  title: string;
  parentId: string | null;
  position: number;
  version: number;
  content: string;
  publishedAt: Date;
}

/**
 * The project's exportable documents that have a published version (in one folder, at any
 * depth, or only those given), as that version was saved.
 */
export async function publishedDocuments(projectId: string, scope: { folderId?: string; documentIds?: string[] } = {}): Promise<PublishedDocument[]> {
  const store = documentStore();
  const documents = await store.list(projectId);
  const within = scope.folderId ? new Set(withDescendants(documents, scope.folderId)) : null;
  const chosen = documents.filter(d =>
    d.kind === 'document' && d.exportable && d.publishedVersion !== null
    && (!within || within.has(d.id))
    && (!scope.documentIds?.length || scope.documentIds.includes(d.id)));
  const published = await Promise.all(chosen.map(async d => {
    const version = await store.version(projectId, d.id, d.publishedVersion!);
    return version && {
      id: d.id, title: version.title, parentId: d.parentId, position: d.position,
      version: version.version, content: version.content, publishedAt: version.createdAt,
    };
  }));
  return published.filter((d): d is PublishedDocument => !!d);
}

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Auth, DocumentAuthor, DocumentKind, ProjectDocument, StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { activeMemberOf, canEditProject, isProjectMember } from '../../utils/auth';
import { emitToUser } from '../../services/wsHub';
import { authorOf, documentStore, DocumentSummary, replaceSection, withDescendants } from '../../services/documents';
import { tokenAllows } from '../../services/auth';
import { checkSheetContent } from '../../services/creditsSheets';

const MAX_TITLE = 200;
const MAX_CONTENT = 1_000_000;

type Action = 'created' | 'saved' | 'changed' | 'deleted';

// What happened to a project's documents, to whoever is in it now: a view of a document
// refreshes itself, an editor warns of a newer version. `version` and `author` come with a save.
function broadcast(project: any, data: { action: Action; documentIds: string[]; version?: number; title?: string; author: DocumentAuthor }) {
  const projectId = String(project._id ?? project.id);
  for (const member of project.members ?? []) {
    if (activeMemberOf(project, member.userId)) emitToUser(member.userId, { type: 'documentEvent', data: { projectId, ...data } });
  }
}

const isVersion = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

function checkTitle(value: unknown): string | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'A title is required' };
  if (value.trim().length > MAX_TITLE) return { error: `A title has at most ${MAX_TITLE} characters` };
  return value.trim();
}

function checkContent(value: unknown, kind: DocumentKind = 'document'): string | { error: string } {
  if (kind === 'credits') return checkSheetContent(value);
  if (typeof value !== 'string') return { error: 'content must be text (markdown)' };
  if (value.length > MAX_CONTENT) return { error: `A document has at most ${MAX_CONTENT} characters` };
  return value;
}

// Where a document may go: the top (null), or a folder of the same project that isn't the
// document itself nor inside it.
function checkParent(value: unknown, documents: DocumentSummary[], movingId?: string): string | null | { error: string } {
  if (value === null) return null;
  if (typeof value !== 'string') return { error: 'parentId must be a folder\'s id, or null' };
  const parent = documents.find(d => d.id === value);
  if (!parent) return { error: 'No such folder in this project' };
  if (parent.kind !== 'folder') return { error: 'A document goes in a folder, not in another document' };
  if (movingId && withDescendants(documents, movingId).includes(value)) return { error: 'A folder can\'t go inside itself' };
  return value;
}

const failed = (value: unknown): value is { error: string } => typeof value === 'object' && value !== null && 'error' in value;

export function documentRouter(_config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // The project, if the caller may see it (or, with `edit`, change it); otherwise the answer.
  async function projectFor(req: Request, res: Response, edit = false) {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.projectId });
    if (!project) { res.status(404).json({ message: 'Project not found' }); return null; }
    if (!(edit ? canEditProject : isProjectMember)(project, auth.userId)) { res.status(403).json({ message: 'Unauthorized' }); return null; }
    return { project, auth, projectId: String(req.params.projectId) };
  }

  const conflict = (res: Response, current: ProjectDocument) => res.status(409).json({
    message: `The document changed: it's at version ${current.version} now. Read it again, and make the change on that version.`,
    document: current,
  });

  router.get('/projects/:projectId/documents', async (req, res) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      res.json({ documents: await documentStore().list(found.projectId) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.post('/projects/:projectId/documents', async (req, res) => {
    try {
      const found = await projectFor(req, res, true);
      if (!found) return;
      const { project, auth, projectId } = found;
      if (req.body?.kind !== undefined && !['document', 'folder', 'credits'].includes(req.body.kind)) return res.status(400).json({ message: "kind is 'document', 'folder' or 'credits'" });
      const kind: DocumentKind = req.body?.kind ?? 'document';
      const title = checkTitle(req.body?.title);
      if (failed(title)) return res.status(400).json({ message: title.error });
      if (kind === 'folder' && req.body?.content) return res.status(400).json({ message: 'A folder has no content' });
      const content = kind === 'folder' ? '' : checkContent(req.body?.content ?? '', kind);
      if (failed(content)) return res.status(400).json({ message: content.error });

      const store = documentStore();
      const documents = await store.list(projectId);
      const parentId = checkParent(req.body?.parentId ?? null, documents);
      if (failed(parentId)) return res.status(400).json({ message: parentId.error });
      if (req.body?.position !== undefined && !Number.isInteger(req.body.position)) return res.status(400).json({ message: 'position must be a whole number' });
      // At the end of its folder, unless placed.
      const siblings = documents.filter(d => d.parentId === parentId);
      const position = req.body?.position ?? (siblings.length ? Math.max(...siblings.map(d => d.position)) + 1 : 0);

      const now = new Date();
      const author = authorOf(auth);
      const document = await store.create({
        id: crypto.randomUUID(), projectId, kind, title, parentId, position, content, version: 1,
        exportable: false, publishedVersion: null, createdAt: now, createdBy: author, updatedAt: now, updatedBy: author,
      });
      broadcast(project, { action: 'created', documentIds: [document.id], version: 1, title, author });
      res.status(201).json({ document });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/projects/:projectId/documents/:docId', async (req, res) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      const document = await documentStore().get(found.projectId, req.params.docId);
      if (!document) return res.status(404).json({ message: 'Document not found' });
      res.json({ document });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Its title or content (a new version, made on `baseVersion`), and where it is in the tree
  // or whether it's exportable (not a version).
  router.patch('/projects/:projectId/documents/:docId', async (req, res) => {
    try {
      const found = await projectFor(req, res, true);
      if (!found) return;
      const { project, auth, projectId } = found;
      const { docId } = req.params;
      const body = req.body ?? {};
      const store = documentStore();
      const current = await store.get(projectId, docId);
      if (!current) return res.status(404).json({ message: 'Document not found' });

      const changesText = body.title !== undefined || body.content !== undefined;
      const changesPlace = body.parentId !== undefined || body.position !== undefined || body.exportable !== undefined;
      if (!changesText && !changesPlace) return res.status(400).json({ message: 'Nothing to change: title, content, parentId, position or exportable' });

      // Everything is checked before anything changes.
      let text: { title: string; content: string } | undefined;
      if (changesText) {
        if (!isVersion(body.baseVersion)) return res.status(400).json({ message: 'baseVersion is required: the version the change was made on' });
        const title = body.title === undefined ? current.title : checkTitle(body.title);
        if (failed(title)) return res.status(400).json({ message: title.error });
        if (current.kind === 'folder' && body.content) return res.status(400).json({ message: 'A folder has no content' });
        const content = body.content === undefined ? current.content : checkContent(body.content, current.kind);
        if (failed(content)) return res.status(400).json({ message: content.error });
        text = { title, content };
      }
      const place: { parentId?: string | null; position?: number; exportable?: boolean } = {};
      if (body.parentId !== undefined) {
        const parentId = checkParent(body.parentId, await store.list(projectId), docId);
        if (failed(parentId)) return res.status(400).json({ message: parentId.error });
        place.parentId = parentId;
      }
      if (body.position !== undefined) {
        if (!Number.isInteger(body.position)) return res.status(400).json({ message: 'position must be a whole number' });
        place.position = body.position;
      }
      if (body.exportable !== undefined) {
        // Whether its exports deliver it is publishing it: a token needs docs:publish.
        if (auth.apiToken && !tokenAllows(auth.apiToken, 'docs:publish')) {
          return res.status(403).json({ error: "This API token doesn't have the 'docs:publish' permission" });
        }
        if (typeof body.exportable !== 'boolean') return res.status(400).json({ message: 'exportable is true or false' });
        if (current.kind === 'folder') return res.status(400).json({ message: 'A folder isn\'t exported: its documents are' });
        place.exportable = body.exportable;
      }

      const author = authorOf(auth);
      let document: ProjectDocument | null = current;
      if (text) {
        document = await store.save(projectId, docId, body.baseVersion, text, author, new Date());
        if (!document) {
          const now = await store.get(projectId, docId);
          return now ? conflict(res, now) : res.status(404).json({ message: 'Document not found' });
        }
      }
      if (changesPlace) document = await store.update(projectId, docId, place);
      if (!document) return res.status(404).json({ message: 'Document not found' });

      broadcast(project, text
        ? { action: 'saved', documentIds: [docId], version: document.version, title: document.title, author }
        : { action: 'changed', documentIds: [docId], author });
      res.json({ document });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // What's under one of its headings, the rest untouched: a new version, made on `baseVersion`.
  router.patch('/projects/:projectId/documents/:docId/sections', async (req, res) => {
    try {
      const found = await projectFor(req, res, true);
      if (!found) return;
      const { project, auth, projectId } = found;
      const { docId } = req.params;
      const { baseVersion, heading, content } = req.body ?? {};
      if (!isVersion(baseVersion)) return res.status(400).json({ message: 'baseVersion is required: the version the change was made on' });
      if (typeof heading !== 'string' || !heading.trim()) return res.status(400).json({ message: 'heading is required: the section\'s heading, e.g. "## Architecture"' });
      const body = checkContent(content);
      if (failed(body)) return res.status(400).json({ message: body.error });

      const store = documentStore();
      const current = await store.get(projectId, docId);
      if (!current) return res.status(404).json({ message: 'Document not found' });
      if (current.kind === 'folder') return res.status(400).json({ message: 'A folder has no content' });
      if (current.kind === 'credits') return res.status(400).json({ message: 'A credits sheet has no sections: its content is its sources' });
      // A section of another version than the one it was read on could be another text.
      if (current.version !== baseVersion) return conflict(res, current);

      const replaced = replaceSection(current.content, heading, body);
      if ('error' in replaced) {
        return replaced.error === 'not-found'
          ? res.status(404).json({ message: `No section "${heading.trim()}" in the document` })
          : res.status(400).json({ message: `More than one section is "${heading.trim()}": give the heading with its #s, or update the whole document` });
      }
      const author = authorOf(auth);
      const document = await store.save(projectId, docId, baseVersion, { title: current.title, content: replaced.content }, author, new Date());
      if (!document) {
        const now = await store.get(projectId, docId);
        return now ? conflict(res, now) : res.status(404).json({ message: 'Document not found' });
      }
      broadcast(project, { action: 'saved', documentIds: [docId], version: document.version, title: document.title, author });
      res.json({ document });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/projects/:projectId/documents/:docId/versions', async (req, res) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      const store = documentStore();
      if (!(await store.get(found.projectId, req.params.docId))) return res.status(404).json({ message: 'Document not found' });
      res.json({ versions: await store.versions(found.projectId, req.params.docId) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  router.get('/projects/:projectId/documents/:docId/versions/:version', async (req, res) => {
    try {
      const found = await projectFor(req, res);
      if (!found) return;
      const number = Number(req.params.version);
      const version = isVersion(number) ? await documentStore().version(found.projectId, req.params.docId, number) : null;
      if (!version) return res.status(404).json({ message: 'Version not found' });
      res.json({ version });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // The version its exports deliver (null: none, it's no longer published). Editing it later
  // changes nothing exported until another version is published.
  router.post('/projects/:projectId/documents/:docId/publish', async (req, res) => {
    try {
      const found = await projectFor(req, res, true);
      if (!found) return;
      const { project, auth, projectId } = found;
      const { docId } = req.params;
      const version = req.body?.version;
      if (version !== null && !isVersion(version)) return res.status(400).json({ message: 'version is the version to publish, or null to publish none' });
      const store = documentStore();
      const current = await store.get(projectId, docId);
      if (!current) return res.status(404).json({ message: 'Document not found' });
      if (current.kind === 'folder') return res.status(400).json({ message: 'A folder isn\'t published: its documents are' });
      if (version !== null && version > current.version) return res.status(404).json({ message: 'Version not found' });

      const document = await store.update(projectId, docId, { publishedVersion: version });
      broadcast(project, { action: 'changed', documentIds: [docId], author: authorOf(auth) });
      res.json({ document });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // A document, or a folder with everything in it.
  router.delete('/projects/:projectId/documents/:docId', async (req, res) => {
    try {
      const found = await projectFor(req, res, true);
      if (!found) return;
      const { project, auth, projectId } = found;
      const store = documentStore();
      const documents = await store.list(projectId);
      if (!documents.some(d => d.id === req.params.docId)) return res.status(404).json({ message: 'Document not found' });
      const ids = withDescendants(documents, req.params.docId);
      await store.remove(projectId, ids);
      broadcast(project, { action: 'deleted', documentIds: ids, author: authorOf(auth) });
      res.json({ deleted: ids });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

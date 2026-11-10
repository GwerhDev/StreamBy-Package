import { Router, Request, Response } from 'express';
import { addToWorkflow, removeFromWorkflow } from '../../services/workflowResources';
import { rememberDisconnectedBuiltin } from './projectResources';
import { connectIntegration } from '../../services/projectIntegration';
import { ObjectId } from 'mongodb';
import { StreamByConfig, Auth, DbConnection, ExternalDbType, CreateTableSchema } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { sanitizeConnection, sanitizeConnections } from '../../utils/sanitize';
import { encrypt, isEncryptionKeySet } from '../../utils/encryption';
import { resolveDbConnectionClient, releaseDbClient, findDbConnection, ResolvedDbClient } from '../../services/connectionResolver';
import {
  listTablesInternal,
  queryRecordsInternal,
  createTableOrCollectionInternal,
  insertRecordInternal,
  updateRecordInternal,
  queryRecordByIdInternal,
  replaceRecordInternal,
  recordVersion,
  RecordError,
  deleteRecordInternal,
  deleteTableOrCollectionInternal,
} from '../../services/dbConnection';

const VALID_DB_TYPES: ExternalDbType[] = ['postgresql', 'mongodb'];

// Resolves the client for `connId`, runs `fn`, and writes the response — releasing
// ephemeral (non-builtin) clients afterward. Builtin clients are pooled and owned by
// connectionManager, never closed here. Responds with the resolve error directly if
// resolution fails, so callers never have to distinguish an error shape from fn's result.
async function withResolvedDbClient(
  project: any,
  connId: string,
  config: StreamByConfig,
  auth: Auth,
  res: Response,
  fn: (resolved: ResolvedDbClient) => Promise<void>,
): Promise<void> {
  const resolved = await resolveDbConnectionClient(project, connId, config, auth);
  if ('error' in resolved) {
    res.status(resolved.status).json({ message: resolved.error });
    return;
  }
  try {
    await fn(resolved);
  } finally {
    await releaseDbClient(resolved);
  }
}

export function dbConnectionRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // ─── List DB connections ──────────────────────────────────────────────────
  router.get('/projects/:id/connections/db', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      return res.status(200).json({ data: sanitizeConnections(project.dbConnections) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch DB connections', details: err.message });
    }
  });

  // The project's database connections as they're answered, after each change too.
  const listNow = async (projectId: string) => sanitizeConnections((await Project.findOne({ _id: projectId }))?.dbConnections);

  // ─── Add DB connection ────────────────────────────────────────────────────
  router.post('/projects/:id/connections/db', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const { name, dbType, credential, integrationId, description } = req.body;
      if (credential && integrationId) {
        return res.status(400).json({ message: 'Provide only one of credential or integrationId' });
      }
      // An integration (the user's, or a built-in) is a named, typed database already.
      if (integrationId) {
        const project = await Project.findOne({ _id: req.params.id });
        if (!project) return res.status(404).json({ message: 'Project not found' });
        if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });
        const result = await connectIntegration(project, integrationId, auth, config, { kind: 'database', description });
        if ('error' in result) return res.status(result.status).json({ message: result.error });
        await addToWorkflow(req.params.id, 'db', result.connection);
        return res.status(201).json({ data: sanitizeConnection(result.connection as DbConnection), dbConnections: await listNow(req.params.id) });
      }
      if (!name || !dbType) {
        return res.status(400).json({ message: 'name and dbType are required' });
      }
      if (!credential && !integrationId) {
        return res.status(400).json({ message: 'Either credential or integrationId is required' });
      }
      if (credential && integrationId) {
        return res.status(400).json({ message: 'Provide only one of credential or integrationId' });
      }
      if (!VALID_DB_TYPES.includes(dbType)) {
        return res.status(400).json({ message: `dbType must be one of: ${VALID_DB_TYPES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      let encryptedCredential: string | undefined;
      if (integrationId) {
        const UserIntegrationModel = getModel('user_integrations');
        const integration = await UserIntegrationModel.findOne({ id: integrationId, userId: auth.userId });
        if (!integration) return res.status(404).json({ message: 'Integration not found' });
        if (integration.kind !== 'database') return res.status(400).json({ message: 'Integration is not a database integration' });
      } else {
        if (!isEncryptionKeySet()) return res.status(500).json({ message: 'Encryption key is not set' });
        encryptedCredential = encrypt(credential);
      }

      const connection: DbConnection = {
        id: new ObjectId().toHexString(),
        name,
        dbType,
        projectId: req.params.id,
        createdAt: new Date(),
        source: integrationId ? 'integration' : 'manual',
        ...(integrationId && { integrationId }),
        ...(encryptedCredential !== undefined && { encryptedCredential }),
        ...(description !== undefined && { description }),
      };

      await Project.update({ _id: req.params.id }, { $push: { dbConnections: connection } });
      await addToWorkflow(req.params.id, 'db', connection);
      return res.status(201).json({ data: sanitizeConnection(connection), dbConnections: await listNow(req.params.id) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add DB connection', details: err.message });
    }
  });

  // ─── Delete DB connection ─────────────────────────────────────────────────
  router.delete('/projects/:id/connections/db/:connId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });
      // A built-in is disconnected, not deleted: what the project keeps in it stays, and it can
      // be connected again (routes/projectResources).
      await Project.update({ _id: req.params.id }, { $pull: { dbConnections: { id: req.params.connId } } });
      if (conn.source === 'builtin') await rememberDisconnectedBuiltin(req.params.id, 'db', conn);
      await removeFromWorkflow(req.params.id, 'db', req.params.connId);
      return res.status(200).json({ message: 'DB connection deleted successfully', dbConnections: await listNow(req.params.id) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete DB connection', details: err.message });
    }
  });

  // ─── List tables / collections ────────────────────────────────────────────
  router.get('/projects/:id/connections/db/:connId/tables', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        const tables = await listTablesInternal(resolved.client, resolved.type, req.params.id);
        res.status(200).json({ data: tables });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list tables', details: err.message });
    }
  });

  // ─── Create table / collection ────────────────────────────────────────────
  router.post('/projects/:id/connections/db/:connId/tables', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const schema: CreateTableSchema = req.body;
      if (!schema.tableName) return res.status(400).json({ message: 'tableName is required' });

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        if (resolved.type === 'sql' && (!Array.isArray(schema.columns) || schema.columns.length === 0)) {
          res.status(400).json({ message: 'columns are required for SQL tables' });
          return;
        }
        await createTableOrCollectionInternal(resolved.client, resolved.type, schema, req.params.id);
        res.status(201).json({ message: `${resolved.type === 'sql' ? 'Table' : 'Collection'} created successfully` });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create table/collection', details: err.message });
    }
  });

  // ─── Delete table / collection ────────────────────────────────────────────
  router.delete('/projects/:id/connections/db/:connId/tables/:tableName', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        await deleteTableOrCollectionInternal(resolved.client, resolved.type, req.params.tableName, req.params.id);
        res.status(200).json({ message: 'Table/collection deleted' });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete table/collection', details: err.message });
    }
  });

  // ─── Query records ────────────────────────────────────────────────────────
  router.get('/projects/:id/connections/db/:connId/tables/:tableName', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const limit  = Math.min(parseInt(String(req.query.limit  ?? 50),  10), 500);
      const offset = Math.max(parseInt(String(req.query.offset ?? 0),   10), 0);

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        const records = await queryRecordsInternal(resolved.client, resolved.type, req.params.tableName, limit, offset, req.params.id);
        res.status(200).json({ data: records });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to query records', details: err.message });
    }
  });

  // ─── Insert record ────────────────────────────────────────────────────────
  router.post('/projects/:id/connections/db/:connId/tables/:tableName', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const record = req.body;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return res.status(400).json({ message: 'Request body must be a JSON object' });
      }

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        const inserted = await insertRecordInternal(resolved.client, resolved.type, req.params.tableName, record, req.params.id);
        res.status(201).json({ data: inserted });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to insert record', details: err.message });
    }
  });

  // ─── Read one record ──────────────────────────────────────────────────────
  // With its version (a hash of what it holds), to change it on (baseVersion).
  router.get('/projects/:id/connections/db/:connId/tables/:tableName/:recordId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        const record = await queryRecordByIdInternal(resolved.client, resolved.type, req.params.tableName, req.params.recordId, req.params.id);
        if (!record) {
          res.status(404).json({ message: 'Record not found' });
          return;
        }
        res.status(200).json({ data: record, version: recordVersion(record) });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to read record', details: err.message });
    }
  });

  // ─── Update record ────────────────────────────────────────────────────────
  // Its fields given, changed (the rest as they are); with ?replace=true, the record is what's
  // given, all of it. With ?baseVersion= (its version as it was read), only on that version: a
  // 409 if it changed since (what an agent always does; the Database section doesn't, yet).
  router.put('/projects/:id/connections/db/:connId/tables/:tableName/:recordId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const updates = req.body;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ message: 'Request body must be a JSON object' });
      }
      const baseVersion = req.query.baseVersion;
      if (baseVersion !== undefined && typeof baseVersion !== 'string') return res.status(400).json({ message: 'baseVersion is the version the record was read at' });
      const replace = req.query.replace === 'true';

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        const { tableName, recordId, id: projectId } = req.params;
        if (baseVersion !== undefined || replace) {
          const current = await queryRecordByIdInternal(resolved.client, resolved.type, tableName, recordId, projectId);
          if (!current) {
            res.status(404).json({ message: 'Record not found' });
            return;
          }
          const version = recordVersion(current);
          if (baseVersion !== undefined && baseVersion !== version) {
            res.status(409).json({ message: 'The record changed since it was read: read it again to see the change.', version });
            return;
          }
        }
        try {
          const updated = replace
            ? await replaceRecordInternal(resolved.client, resolved.type, tableName, recordId, updates, projectId)
            : await updateRecordInternal(resolved.client, resolved.type, tableName, recordId, updates, projectId);
          if (!updated && (baseVersion !== undefined || replace)) {
            res.status(404).json({ message: 'Record not found' });
            return;
          }
          res.status(200).json({ data: updated, ...(updated ? { version: recordVersion(updated) } : {}) });
        } catch (err) {
          if (!(err instanceof RecordError)) throw err;
          res.status(400).json({ message: err.message });
        }
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update record', details: err.message });
    }
  });

  // ─── Delete record ────────────────────────────────────────────────────────
  router.delete('/projects/:id/connections/db/:connId/tables/:tableName/:recordId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!canEditProject(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      await withResolvedDbClient(project, req.params.connId, config, auth, res, async resolved => {
        await deleteRecordInternal(resolved.client, resolved.type, req.params.tableName, req.params.recordId, req.params.id);
        res.status(200).json({ message: 'Record deleted' });
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete record', details: err.message });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { StreamByConfig, Auth, DbConnection, ExternalDbType, CreateTableSchema } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { getConnection } from '../../adapters/database/connectionManager';
import { assertBuiltinAccess } from '../../utils/builtinAccess';
import { getDecryptedIntegrationCredentialById } from '../../services/userIntegration';
import {
  listTablesOrCollections,
  createTableOrCollection,
  queryRecords,
  insertRecord,
  updateRecord,
  deleteRecord,
  deleteTableOrCollection,
  listTablesInternal,
  queryRecordsInternal,
  createTableOrCollectionInternal,
  insertRecordInternal,
  updateRecordInternal,
  deleteRecordInternal,
  deleteTableOrCollectionInternal,
} from '../../services/dbConnection';

const VALID_DB_TYPES: ExternalDbType[] = ['postgresql', 'mongodb'];

// `builtinId` is config.databases[].id (e.g. 'mongo'), NOT the DbConnection row's own id —
// those are different values since TCORE-69's backfill gives each row its own UUID.
function resolveBuiltinConnection(
  builtinId: string,
  config: StreamByConfig,
): { client: Pool | MongoClient; dbType: 'sql' | 'nosql' } | { error: string; status: number } {
  const db = (config.databases ?? []).find(d => d.id === builtinId);
  if (!db) return { error: `Database '${builtinId}' not found in config`, status: 404 };
  try {
    const { client, type } = getConnection(builtinId);
    return { client: client as Pool | MongoClient, dbType: type };
  } catch (e: any) {
    return { error: e.message, status: 503 };
  }
}

// Finds the connection row + classifies it. A row is builtin iff conn.source === 'builtin'
// (persisted at creation/backfill time) — NOT by comparing the row's own id against
// config.databases, which no longer holds since builtin rows get their own generated id.
function findDbConnection(project: any, connId: string): DbConnection | undefined {
  return project.dbConnections?.find((c: DbConnection) => c.id === connId);
}

async function getDecryptedConnectionString(project: any, connId: string): Promise<{ connectionString: string; conn: DbConnection } | { error: string; status: number }> {
  const conn: DbConnection | undefined = project.dbConnections?.find((c: DbConnection) => c.id === connId);
  if (!conn) return { error: 'DB connection not found', status: 404 };

  if (conn.source === 'integration') {
    if (!conn.integrationId) return { error: 'Connection is missing its integrationId', status: 500 };
    const credential = await getDecryptedIntegrationCredentialById(conn.integrationId);
    if (!credential) return { error: 'Integration not found', status: 400 };
    return { connectionString: credential as string, conn };
  }

  const { decrypt, isEncryptionKeySet } = await import('../../utils/encryption');
  if (!isEncryptionKeySet()) return { error: 'Encryption key is not set', status: 500 };

  const credential = project.credentials?.find((c: any) => c.id === conn.credentialId);
  if (!credential) return { error: 'Credential not found in project', status: 400 };

  return { connectionString: decrypt(credential.encryptedValue), conn };
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

      return res.status(200).json({ data: project.dbConnections || [] });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch DB connections', details: err.message });
    }
  });

  // ─── Add DB connection ────────────────────────────────────────────────────
  router.post('/projects/:id/connections/db', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const { name, dbType, credentialId, integrationId, description } = req.body;
      if (!name || !dbType) {
        return res.status(400).json({ message: 'name and dbType are required' });
      }
      if (!credentialId && !integrationId) {
        return res.status(400).json({ message: 'Either credentialId or integrationId is required' });
      }
      if (credentialId && integrationId) {
        return res.status(400).json({ message: 'Provide only one of credentialId or integrationId' });
      }
      if (!VALID_DB_TYPES.includes(dbType)) {
        return res.status(400).json({ message: `dbType must be one of: ${VALID_DB_TYPES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      if (integrationId) {
        const UserIntegrationModel = getModel('user_integrations');
        const integration = await UserIntegrationModel.findOne({ id: integrationId, userId: auth.userId });
        if (!integration) return res.status(404).json({ message: 'Integration not found' });
        if (integration.kind !== 'database') return res.status(400).json({ message: 'Integration is not a database integration' });
      } else {
        const credExists = project.credentials?.some((c: any) => c.id === credentialId);
        if (!credExists) return res.status(400).json({ message: 'Credential not found in project' });
      }

      const connection: DbConnection = {
        id: new ObjectId().toHexString(),
        name,
        dbType,
        credentialId: credentialId ?? '',
        projectId: req.params.id,
        createdAt: new Date(),
        source: integrationId ? 'integration' : 'manual',
        ...(integrationId && { integrationId }),
        ...(description !== undefined && { description }),
      };

      await Project.update({ _id: req.params.id }, { $push: { dbConnections: connection } });
      return res.status(201).json({ data: connection });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to add DB connection', details: err.message });
    }
  });

  // ─── Delete DB connection ─────────────────────────────────────────────────
  router.delete('/projects/:id/connections/db/:connId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });
      if (conn.source === 'builtin') {
        return res.status(403).json({ message: 'Cannot delete a built-in database connection' });
      }

      await Project.update({ _id: req.params.id }, { $pull: { dbConnections: { id: req.params.connId } } });
      return res.status(200).json({ message: 'DB connection deleted successfully' });
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

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        const tables = await listTablesInternal(internal.client, internal.dbType, req.params.id);
        return res.status(200).json({ data: tables });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      const tables = await listTablesOrCollections(resolved.connectionString, resolved.conn.dbType);
      return res.status(200).json({ data: tables });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list tables', details: err.message });
    }
  });

  // ─── Create table / collection ────────────────────────────────────────────
  router.post('/projects/:id/connections/db/:connId/tables', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const schema: CreateTableSchema = req.body;
      if (!schema.tableName) return res.status(400).json({ message: 'tableName is required' });

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        if (internal.dbType === 'sql' && (!Array.isArray(schema.columns) || schema.columns.length === 0)) {
          return res.status(400).json({ message: 'columns are required for SQL tables' });
        }
        await createTableOrCollectionInternal(internal.client, internal.dbType, schema, req.params.id);
        return res.status(201).json({ message: `${internal.dbType === 'sql' ? 'Table' : 'Collection'} created successfully` });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      if (resolved.conn.dbType === 'postgresql' && (!Array.isArray(schema.columns) || schema.columns.length === 0)) {
        return res.status(400).json({ message: 'columns are required for PostgreSQL tables' });
      }

      await createTableOrCollection(resolved.connectionString, resolved.conn.dbType, schema);
      return res.status(201).json({ message: `${resolved.conn.dbType === 'postgresql' ? 'Table' : 'Collection'} created successfully` });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create table/collection', details: err.message });
    }
  });

  // ─── Delete table / collection ────────────────────────────────────────────
  router.delete('/projects/:id/connections/db/:connId/tables/:tableName', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        await deleteTableOrCollectionInternal(internal.client, internal.dbType, req.params.tableName, req.params.id);
        return res.status(200).json({ message: 'Table/collection deleted' });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      await deleteTableOrCollection(resolved.connectionString, resolved.conn.dbType, req.params.tableName);
      return res.status(200).json({ message: 'Table/collection deleted' });
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

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        const records = await queryRecordsInternal(internal.client, internal.dbType, req.params.tableName, limit, offset, req.params.id);
        return res.status(200).json({ data: records });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      const records = await queryRecords(resolved.connectionString, resolved.conn.dbType, req.params.tableName, limit, offset);
      return res.status(200).json({ data: records });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to query records', details: err.message });
    }
  });

  // ─── Insert record ────────────────────────────────────────────────────────
  router.post('/projects/:id/connections/db/:connId/tables/:tableName', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const record = req.body;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return res.status(400).json({ message: 'Request body must be a JSON object' });
      }

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        const inserted = await insertRecordInternal(internal.client, internal.dbType, req.params.tableName, record, req.params.id);
        return res.status(201).json({ data: inserted });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      const inserted = await insertRecord(resolved.connectionString, resolved.conn.dbType, req.params.tableName, record);
      return res.status(201).json({ data: inserted });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to insert record', details: err.message });
    }
  });

  // ─── Update record ────────────────────────────────────────────────────────
  router.put('/projects/:id/connections/db/:connId/tables/:tableName/:recordId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') return res.status(403).json({ message: 'Permission denied' });

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const updates = req.body;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ message: 'Request body must be a JSON object' });
      }

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        const updated = await updateRecordInternal(internal.client, internal.dbType, req.params.tableName, req.params.recordId, updates, req.params.id);
        return res.status(200).json({ data: updated });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      const updated = await updateRecord(resolved.connectionString, resolved.conn.dbType, req.params.tableName, req.params.recordId, updates);
      return res.status(200).json({ data: updated });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update record', details: err.message });
    }
  });

  // ─── Delete record ────────────────────────────────────────────────────────
  router.delete('/projects/:id/connections/db/:connId/tables/:tableName/:recordId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') return res.status(403).json({ message: 'Permission denied' });

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const conn = findDbConnection(project, req.params.connId);
      if (!conn) return res.status(404).json({ message: 'DB connection not found' });

      if (conn.source === 'builtin') {
        const builtinId = conn.integrationId!;
        if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
          return res.status(403).json({ message: 'Access to this built-in database is not permitted' });
        }
        const internal = resolveBuiltinConnection(builtinId, config);
        if ('error' in internal) return res.status(internal.status).json({ message: internal.error });
        await deleteRecordInternal(internal.client, internal.dbType, req.params.tableName, req.params.recordId, req.params.id);
        return res.status(200).json({ message: 'Record deleted' });
      }

      const resolved = await getDecryptedConnectionString(project, req.params.connId);
      if ('error' in resolved) return res.status(resolved.status).json({ message: resolved.error });

      await deleteRecord(resolved.connectionString, resolved.conn.dbType, req.params.tableName, req.params.recordId);
      return res.status(200).json({ message: 'Record deleted' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete record', details: err.message });
    }
  });

  return router;
}

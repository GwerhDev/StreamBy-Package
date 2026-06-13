import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { StreamByConfig, Auth, DbConnection, ExternalDbType, CreateTableSchema } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { getConnection } from '../../adapters/database/connectionManager';
import {
  listTablesOrCollections,
  createTableOrCollection,
  queryRecords,
  insertRecord,
  listTablesInternal,
  queryRecordsInternal,
  createTableOrCollectionInternal,
  insertRecordInternal,
} from '../../services/dbConnection';

const VALID_DB_TYPES: ExternalDbType[] = ['postgresql', 'mongodb'];

function isBuiltinDb(connId: string, config: StreamByConfig): boolean {
  return (config.databases ?? []).some(db => db.id === connId);
}

function resolveBuiltinConnection(
  connId: string,
  config: StreamByConfig,
): { client: Pool | MongoClient; dbType: 'sql' | 'nosql' } | { error: string; status: number } {
  const db = (config.databases ?? []).find(d => d.id === connId);
  if (!db) return { error: `Database '${connId}' not found in config`, status: 404 };
  try {
    const { client, type } = getConnection(connId);
    return { client: client as Pool | MongoClient, dbType: type };
  } catch (e: any) {
    return { error: e.message, status: 503 };
  }
}

async function getDecryptedConnectionString(project: any, connId: string): Promise<{ connectionString: string; conn: DbConnection } | { error: string; status: number }> {
  const conn: DbConnection | undefined = project.dbConnections?.find((c: DbConnection) => c.id === connId);
  if (!conn) return { error: 'DB connection not found', status: 404 };

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

      const { name, dbType, credentialId, description } = req.body;
      if (!name || !dbType || !credentialId) {
        return res.status(400).json({ message: 'name, dbType, and credentialId are required' });
      }
      if (!VALID_DB_TYPES.includes(dbType)) {
        return res.status(400).json({ message: `dbType must be one of: ${VALID_DB_TYPES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const credExists = project.credentials?.some((c: any) => c.id === credentialId);
      if (!credExists) return res.status(400).json({ message: 'Credential not found in project' });

      const connection: DbConnection = {
        id: new ObjectId().toHexString(),
        name,
        dbType,
        credentialId,
        projectId: req.params.id,
        createdAt: new Date(),
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
      if (isBuiltinDb(req.params.connId, config)) {
        return res.status(403).json({ message: 'Cannot delete a built-in database connection' });
      }

      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const exists = project.dbConnections?.some((c: any) => c.id === req.params.connId);
      if (!exists) return res.status(404).json({ message: 'DB connection not found' });

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

      if (isBuiltinDb(req.params.connId, config)) {
        const internal = resolveBuiltinConnection(req.params.connId, config);
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

      if (isBuiltinDb(req.params.connId, config)) {
        const internal = resolveBuiltinConnection(req.params.connId, config);
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

  // ─── Query records ────────────────────────────────────────────────────────
  router.get('/projects/:id/connections/db/:connId/tables/:tableName', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized project access' });

      const limit  = Math.min(parseInt(String(req.query.limit  ?? 50),  10), 500);
      const offset = Math.max(parseInt(String(req.query.offset ?? 0),   10), 0);

      if (isBuiltinDb(req.params.connId, config)) {
        const internal = resolveBuiltinConnection(req.params.connId, config);
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

      if (isBuiltinDb(req.params.connId, config)) {
        const internal = resolveBuiltinConnection(req.params.connId, config);
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

  return router;
}

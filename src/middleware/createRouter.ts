import express, { Router } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { registerModel } from '../models/manager';
import { createStorageProvider } from '../providers/storage';
import { initConnections } from '../adapters/database/connectionManager';

import { authRouter } from './routes/auth';
import { databaseRouter } from './routes/database';
import { storageRouter } from './routes/storage';
import { projectRouter } from './routes/project';
import { exportRouter } from './routes/export';

import { authenticate } from '../services/auth';

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  initConnections(config.databases || []);

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);

  if (config.databases) {
    const allDbIds = config.databases.map(db => db.id);
    const sqlDbs = config.databases.filter(db => db.type === 'sql');
    const streambySchema = sqlDbs.length > 0 ? 'streamby' : undefined;

    registerModel('projects', allDbIds, 'projects', streambySchema);
    registerModel('exports', allDbIds, 'exports', streambySchema);

    const mainDb = config.databases.find(db => db.main);
    if (mainDb) {
            registerModel('users', [mainDb.id], 'users', 'accounts');
    }
  }

  router.use(authenticate(config));
  router.use(authRouter(config));
  router.use(databaseRouter(config));
  router.use(storageRouter(config));
  router.use(projectRouter(config));
  router.use(exportRouter(config));

  return router;
}

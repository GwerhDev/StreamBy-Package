import express, { Router } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { registerModel } from '../models/manager';
import { createStorageProvider } from '../providers/storage';
import { initConnections } from '../adapters/database/connectionManager';
import { initWsHub } from '../services/wsHub';
import { authenticate } from '../services/auth';
import { setEncryptionKey } from '../utils/encryption';
import { authRouter } from './routes/auth';
import { userRouter } from './routes/user';
import { exportRouter } from './routes/export';
import { memberRouter } from './routes/member';
import { storageRouter } from './routes/storage';
import { projectRouter } from './routes/project';
import { databaseRouter } from './routes/database';
import { credentialRouter } from './routes/credential';
import { connectionRouter } from './routes/connection';
import { dbConnectionRouter } from './routes/dbConnection';
import { storageConnectionRouter } from './routes/storageConnection';
import { notificationRouter } from './routes/notification';

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  if (config.encrypt) setEncryptionKey(config.encrypt);

  initConnections(config.databases || []);

  const adapter: StorageAdapter = config.adapter || createStorageProvider(config.storageProviders);

  if (config.databases) {
    const allDbIds = config.databases.map(db => db.id);
    const streambySchema = 'streamby';

    registerModel('exports', allDbIds, 'exports', streambySchema);
    registerModel('projects', allDbIds, 'projects', streambySchema);

    const nosqlDbIds = config.databases.filter(db => db.type === 'nosql').map(db => db.id);
    if (nosqlDbIds.length > 0) {
      registerModel('notifications', nosqlDbIds, 'notifications', streambySchema);
      registerModel('storage_files', nosqlDbIds, 'storage_files');
    }

    const mainDb = config.databases.find(db => db.main);
    if (mainDb) {
      registerModel('users', [mainDb.id], 'users', 'accounts');
    }
  }

  if (config.websocket?.server) {
    initWsHub(config.websocket.server, config);
  }

  router.use(userRouter(config));
  router.use(authRouter(config));
  router.use(authenticate(config));
  router.use(exportRouter(config));
  router.use(memberRouter(config));
  router.use(storageRouter(config));
  router.use(projectRouter(config));
  router.use(databaseRouter(config));
  router.use(credentialRouter(config));
  router.use(connectionRouter(config));
  router.use(dbConnectionRouter(config));
  router.use(storageConnectionRouter(config));
  router.use(notificationRouter(config));

  return router;
}

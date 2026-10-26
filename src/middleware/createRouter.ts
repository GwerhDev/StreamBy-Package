import express, { Router } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
import { registerModel } from '../models/manager';
import { createStorageProvider } from '../providers/storage';
import { initConnections } from '../adapters/database/connectionManager';
import { backfillBuiltinConnections } from '../services/backfillBuiltinConnections';
import { reencryptStoredCredentials } from '../services/reencryptCredentials';
import { initWsHub } from '../services/wsHub';
import { authenticate, enforceApiTokenScope } from '../services/auth';
import { apiTokenRouter } from './routes/apiToken';
import { mcpRouter } from './routes/mcp';
import { setEncryptionKey } from '../utils/encryption';
import { setJobStoreDatabase } from '../services/jobStore';
import { authRouter } from './routes/auth';
import { userRouter } from './routes/user';
import { exportRouter } from './routes/export';
import { memberRouter } from './routes/member';
import { storageRouter } from './routes/storage';
import { projectRouter } from './routes/project';
import { databaseRouter } from './routes/database';
import { connectionRouter } from './routes/connection';
import { dbConnectionRouter } from './routes/dbConnection';
import { storageConnectionRouter } from './routes/storageConnection';
import { userIntegrationRouter } from './routes/userIntegration';
import { oauthRouter } from './routes/oauth';
import { notificationRouter } from './routes/notification';
import { subscriptionRouter, ensureSubscription } from './routes/subscription';
import { mediaRouter } from './routes/media';
import { renderFarmRouter } from './routes/renderFarm';
import { reviewRouter } from './routes/review';
import { distributionRouter } from './routes/distribution';
import { aiRouter } from './routes/ai';
import { productionRouter } from './routes/production';
import { rightsRouter } from './routes/rights';
import { workflowRouter } from './routes/workflow';
import { pipelineRouter } from './routes/pipeline';
import { workerRouter } from './routes/worker';
import { workerCallbackRouter } from './routes/workerCallback';
import { startWorkerSweeper } from '../services/workerJobs';
import { deliverableRouter } from './routes/deliverable';

export function createStreamByRouter(config: StreamByConfig & { adapter?: StorageAdapter }): Router {
  const router = express.Router();

  if (config.encrypt) setEncryptionKey(config.encrypt, config.encryptPreviousKeys);
  setJobStoreDatabase(config);

  // Establish DB connections asynchronously (Postgres/Mongo + schema migrations).
  // Until they're ready, HOLD incoming requests instead of letting them through —
  // route handlers resolve projects/exports (e.g. the /menu-list export) against a
  // live connection, so hitting them before startup finishes would 404. This gate
  // makes the client's fetch wait for StreamBy's instances to come up.
  let ready = false;
  const readyPromise = initConnections(config.databases || [])
    .catch((err) => {
      console.error('❌ StreamBy: failed to initialize database connections:', err);
    })
    .then(() => backfillBuiltinConnections(config))
    .catch((err) => {
      console.error('❌ StreamBy: failed to backfill built-in connections:', err);
    })
    .then(() => reencryptStoredCredentials())
    .then(({ updated, failed }) => {
      if (updated) console.log(`✅ StreamBy: re-encrypted the credentials of ${updated} record(s).`);
      if (failed) console.error(`❌ StreamBy: ${failed} stored credential(s) could not be decrypted with the configured keys; left as they are.`);
    })
    .catch((err) => {
      console.error('❌ StreamBy: failed to re-encrypt stored credentials:', err);
    })
    .finally(() => {
      ready = true;
      // Jobs left pending (or with their worker's time up) by a restart are sent again.
      startWorkerSweeper({ ...config, adapter });
    });

  router.use((_req, _res, next) => {
    if (ready) return next();
    readyPromise.then(() => next());
  });

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
      registerModel('media_metadata', nosqlDbIds, 'media_metadata');
      registerModel('asset_versions', nosqlDbIds, 'asset_versions');
      registerModel('asset_dependency_graphs', nosqlDbIds, 'asset_dependency_graphs');
      registerModel('review_sessions', nosqlDbIds, 'review_sessions');
      registerModel('annotations', nosqlDbIds, 'annotations');
      registerModel('qc_reports', nosqlDbIds, 'qc_reports');
      registerModel('generative_jobs', nosqlDbIds, 'generative_jobs');
    }

    const mainDb = config.databases.find(db => db.main);
    if (mainDb) {
      registerModel('users', [mainDb.id], 'users', 'accounts');
      registerModel('user_subscriptions', [mainDb.id], 'user_subscriptions', 'streamby');
      registerModel('user_integrations', [mainDb.id], 'user_integrations', streambySchema);
      registerModel('api_tokens', [mainDb.id], 'api_tokens', streambySchema);
      registerModel('mcp_audit', [mainDb.id], 'mcp_audit', streambySchema);
    }
  }

  if (config.websocket?.server) {
    initWsHub(config.websocket.server, config);
  }

  // /auth answers whether there's a session (it reads it itself); everything after needs one,
  // but for the public export route (see authenticate).
  router.use(authRouter(config));
  // Workers call back with their job's token, not a session (see routes/workerCallback).
  router.use(workerCallbackRouter({ ...config, adapter }));
  router.use(authenticate(config));
  router.use(enforceApiTokenScope);
  router.use(ensureSubscription);
  router.use(userRouter(config));
  router.use(apiTokenRouter(config));
  router.use(mcpRouter(config));
  router.use(exportRouter(config));
  router.use(memberRouter(config));
  router.use(storageRouter(config));
  router.use(projectRouter(config));
  router.use(databaseRouter(config));
  router.use(connectionRouter(config));
  router.use(dbConnectionRouter(config));
  router.use(storageConnectionRouter(config));
  router.use(userIntegrationRouter(config));
  router.use(oauthRouter(config));
  router.use(notificationRouter(config));
  router.use(subscriptionRouter(config));
  router.use(mediaRouter(config));
  router.use(renderFarmRouter(config));
  router.use(reviewRouter(config));
  router.use(distributionRouter(config));
  router.use(aiRouter(config));
  router.use(productionRouter(config));
  router.use(rightsRouter(config));
  router.use(workflowRouter(config));
  router.use(pipelineRouter(config));
  router.use(workerRouter({ ...config, adapter }));
  router.use(deliverableRouter({ ...config, adapter }));

  return router;
}

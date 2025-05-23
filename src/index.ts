import express from 'express';
import { createStreamByRouter } from './middleware/createRouter';
import { StreamByConfig, StorageAdapter } from './types';

export { createS3Adapter } from './adapters/s3';
export { initProjectModel } from './db/initProjectModel';
export { createStreamByRouter } from './middleware/createRouter';
export { createMongoProjectProvider } from './providers/mongoProjectProvider';

export function createStreamByApp(config: StreamByConfig & { adapter?: StorageAdapter }) {
  const app = express();

  app.use(express.json());
  app.use(createStreamByRouter(config));

  return app;
}

import express from 'express';
import { createStreamByRouter } from './middleware/createRouter';
import { StreamByConfig, StorageAdapter } from './types';

export function createStreamByApp(config: StreamByConfig & { adapter?: StorageAdapter }) {
  const app = express();

  app.use(express.json());
  app.use(createStreamByRouter(config));

  return app;
}

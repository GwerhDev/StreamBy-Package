import express from 'express';
import { createStreamByRouter } from '../middleware/createRouter';
import { StorageAdapter, StreamByConfig } from "../types";

export function createDevServer(config: StreamByConfig & { adapter?: StorageAdapter }) {
  const app = express();

  app.use(express.json());
  app.use(createStreamByRouter(config));

  return app;
}
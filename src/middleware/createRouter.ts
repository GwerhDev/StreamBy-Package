import express from 'express';
import type { StreamByConfig } from '../types';
import {
  createProjectService,
  updateProjectService,
  deleteProjectImageService
} from '../services/project';

export function createRouter(config: StreamByConfig) {
  const app = express.Router();

  app.post('/project', (req, res) => {
    createProjectService(req, config.authProvider, config.projectProvider)
      .then((result) => res.json(result))
      .catch((err) => res.status(400).json({ error: err.message }));
  });

  app.put('/project/:projectId', (req, res) => {
    updateProjectService(req, config.authProvider, config.projectProvider)
      .then((result) => res.json(result))
      .catch((err) => res.status(400).json({ error: err.message }));
  });

  app.delete('/project/:projectId/image', (req, res) => {
    deleteProjectImageService(req, config.authProvider, config.projectProvider, config.storageAdapter)
      .then((result) => res.json(result))
      .catch((err) => res.status(400).json({ error: err.message }));
  });

  return app;
}

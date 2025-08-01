import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { createExport, createRawExport } from '../../services/export';
import { getConnection } from '../../adapters/database/connectionManager';
import { MongoClient, ObjectId } from 'mongodb';

export function exportRouter(config: StreamByConfig): Router {
  const router = Router();

  const Project = getModel('projects');

  router.get('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const exportId = req.params.export_id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized access' });
      }

      const exportMetadata = project.exports.find((e: any) => e.id.toString() === exportId);

      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found in this project' });
      }

      const targetDb = config.databases?.find(db => db.type === project.dbType);

      if (!targetDb) {
        return res.status(500).json({ message: `Database connection not found for type ${project.dbType}` });
      }

      const connection = getConnection(targetDb.id);
      let data;

      if (project.dbType === 'nosql') {
        const db = (connection.client as MongoClient).db();
        if (exportMetadata.type === 'raw') {
          const rawData = await db.collection(exportMetadata.collectionName).findOne({ _id: new ObjectId(exportId) });
          data = rawData ? { json: rawData.json, name: rawData.name, method: rawData.method, collectionName: rawData.collectionName, createdAt: rawData.createdAt, updatedAt: rawData.updatedAt, type: exportMetadata.type } : null;
        } else {
          data = await db.collection(exportMetadata.collectionName).find({ __metadata: { $exists: false } }).toArray();
        }
      } else if (project.dbType === 'sql') {
        // ... SQL implementation needed
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      res.json({ data, message: 'Export data fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch export data', details: err.message });
    }
  });

  router.post('/projects/:id/exports', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const { name, description, collectionName, fields } = req.body;

      if (!name || !collectionName || !fields) {
        return res.status(400).json({ message: 'Missing export name, collectionName, or fields' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const result = await createExport(config, projectId, name, collectionName, fields, project.dbType);

      res.status(201).json({ data: result, message: result.message });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create export', details: err.message });
    }
  });

  router.post('/projects/:id/exports/raw', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (
        !auth ||
        !auth.userId ||
        !auth.role
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const projectId = req.params.id;
      const { name, description, collectionName, jsonData } = req.body;

      if (!name || !collectionName || !jsonData) {
        return res.status(400).json({ message: 'Missing export name, collectionName, or jsonData' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }
      
      const result = await createRawExport(config, projectId, name, collectionName, jsonData, project.dbType);

      res.status(201).json({ data: result, message: result.message });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create raw export', details: err.message });
    }
  });

  router.get('/:projectId/public-export/:exportName', async (req: Request, res: Response) => {
    try {
      const { projectId, exportName } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const exportMetadata = project.exports.find((e: any) => e.name === exportName);
      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found in this project' });
      }

      const targetDb = config.databases?.find(db => db.type === project.dbType);
      if (!targetDb) {
        return res.status(500).json({ message: `Database connection not found for type ${project.dbType}` });
      }

      const connection = getConnection(targetDb.id);
      let data;

      if (project.dbType === 'nosql') {
        const db = (connection.client as MongoClient).db();
        if (exportMetadata.type === 'raw') {
          const rawData = await db.collection(exportMetadata.collectionName).findOne({ _id: new ObjectId(exportMetadata.id) });
          data = rawData ? rawData.json : null;
        } else {
          data = await db.collection(exportMetadata.collectionName).find({ __metadata: { $exists: false } }).toArray();
        }
      } else if (project.dbType === 'sql') {
        // SQL implementation for public exports will go here
        return res.status(501).json({ message: 'SQL public exports not yet implemented' });
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      res.json(data); // Return the raw data directly
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch public export data', details: err.message });
    }
  });

  router.get('/:projectId/public-export/:exportName', async (req: Request, res: Response) => {
    try {
      const { projectId, exportName } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const exportMetadata = project.exports.find((e: any) => e.name === exportName);
      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found in this project' });
      }

      const targetDb = config.databases?.find(db => db.type === project.dbType);
      if (!targetDb) {
        return res.status(500).json({ message: `Database connection not found for type ${project.dbType}` });
      }

      const connection = getConnection(targetDb.id);
      let data;

      if (project.dbType === 'nosql') {
        const db = (connection.client as MongoClient).db();
        if (exportMetadata.type === 'raw') {
          const rawData = await db.collection(exportMetadata.collectionName).findOne({ _id: new ObjectId(exportMetadata.id) });
          data = rawData ? rawData.json : null;
        } else {
          data = await db.collection(exportMetadata.collectionName).find({ __metadata: { $exists: false } }).toArray();
        }
      } else if (project.dbType === 'sql') {
        // SQL implementation for public exports will go here
        return res.status(501).json({ message: 'SQL public exports not yet implemented' });
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      res.json(data); // Return the raw data directly
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch public export data', details: err.message });
    }
  });

  router.get('/:projectId/public-export/:exportName', async (req: Request, res: Response) => {
    try {
      const { projectId, exportName } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const exportMetadata = project.exports.find((e: any) => e.name === exportName);
      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found in this project' });
      }

      const targetDb = config.databases?.find(db => db.type === project.dbType);
      if (!targetDb) {
        return res.status(500).json({ message: `Database connection not found for type ${project.dbType}` });
      }

      const connection = getConnection(targetDb.id);
      let data;

      if (project.dbType === 'nosql') {
        const db = (connection.client as MongoClient).db();
        if (exportMetadata.type === 'raw') {
          const rawData = await db.collection(exportMetadata.collectionName).findOne({ _id: new ObjectId(exportMetadata.id) });
          data = rawData ? rawData.json : null;
        } else {
          data = await db.collection(exportMetadata.collectionName).find({ __metadata: { $exists: false } }).toArray();
        }
      } else if (project.dbType === 'sql') {
        // SQL implementation for public exports will go here
        return res.status(501).json({ message: 'SQL public exports not yet implemented' });
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      res.json(data); // Return the raw data directly
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch public export data', details: err.message });
    }
  });

  return router;
}

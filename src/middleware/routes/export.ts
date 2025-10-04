import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { createExport, updateExport, deleteExport } from '../../services/export';
import { getConnection } from '../../adapters/database/connectionManager';
import { MongoClient, ObjectId } from 'mongodb';
import { decrypt, isEncryptionKeySet } from '../../utils/encryption';
import fetch from 'node-fetch'; // Import fetch here

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
        } else if (exportMetadata.type === 'externalApi') {
          const ProjectModel = getModel('projects', 'nosql');
          const currentProject = await ProjectModel.findOne({ _id: projectId });

          if (!currentProject) {
            return res.status(404).json({ message: 'Project not found.' });
          }

          let headers: Record<string, string> = {};
          if (exportMetadata.credentialId) {
            const credential = currentProject.credentials?.find((cred: any) => cred.id === exportMetadata.credentialId);
            if (!credential) {
              return res.status(404).json({ message: `Credential with ID ${exportMetadata.credentialId} not found.` });
            }
            const decryptedValue = decrypt(credential.encryptedValue);
            const authPrefix = exportMetadata.prefix ? `${exportMetadata.prefix} ` : 'Bearer ';
            headers = {
              'Authorization': `${authPrefix}${decryptedValue}`,
              'Content-Type': 'application/json',
            };
          }

          try {
            const response = await fetch(exportMetadata.apiUrl, { headers });
            if (!response.ok) {
              throw new Error(`Failed to fetch from external API: ${response.statusText}`);
            }

            const responseData = await response.json();
            data = { responseData, name: exportMetadata.name, createdAt: exportMetadata.createdAt, updatedAt: exportMetadata.updatedAt, type: exportMetadata.type, collectionName: exportMetadata.collectionName };

          } catch (error: any) {
            return res.status(500).json({ message: 'Failed to fetch from external API', details: error.message });
          }
        } else {
          data = await db.collection(exportMetadata.collectionName).find({ __metadata: { $exists: false } }).toArray();
        }
      } else if (project.dbType === 'sql') {
        // ... SQL implementation needed
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      let responseData: any;

      if (Array.isArray(data)) {
        responseData = {
          content: data,
          allowedOrigin: exportMetadata.allowedOrigin,
          private: exportMetadata.private,
        };
      } else {
        responseData = {
          ...data,
          allowedOrigin: exportMetadata.allowedOrigin,
          private: exportMetadata.private,
        };
      }

      res.json({
        data: responseData,
        message: 'Export data fetched successfully',
      });
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
      const { name, description, collectionName, jsonData, isPrivate, allowedOrigin, exportType, apiUrl, credentialId, prefix } = req.body;

      if (!name || !collectionName) {
        return res.status(400).json({ message: 'Missing export name or collectionName' });
      }

      if (exportType === 'externalApi') {
        if (!apiUrl) {
          return res.status(400).json({ message: 'API URL is required for externalApi export type' });
        }
      } else if (!jsonData) {
        return res.status(400).json({ message: 'Missing jsonData for non-externalApi export types' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const result = await createExport(config, projectId, name, collectionName, jsonData, project.dbType, exportType || 'raw', isPrivate, allowedOrigin, apiUrl, credentialId, prefix);

      res.status(201).json({ data: result, message: result.message });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create raw export', details: err.message });
    }
  });

  router.patch('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth || !auth.userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { id: projectId, export_id: exportId } = req.params;
      const { name, collectionName, description, jsonData, isPrivate, allowedOrigin, exportType, apiUrl, credentialId, prefix } = req.body;

      if (!name || !collectionName) {
        return res.status(400).json({ message: 'Missing name or collectionName' });
      }

      if (exportType === 'externalApi') {
        if (!apiUrl) {
          return res.status(400).json({ message: 'API URL is required for externalApi export type' });
        }
      } else if (!jsonData) {
        return res.status(400).json({ message: 'Missing jsonData for non-externalApi export types' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const result = await updateExport(config, projectId, exportId, name, collectionName, jsonData, project.dbType, exportType || 'raw', isPrivate, allowedOrigin, apiUrl, credentialId, prefix);

      res.status(200).json({ data: result, message: result.message });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update raw export', details: err.message });
    }
  });

  router.delete('/projects/:id/exports/:export_id', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth || !auth.userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { id: projectId, export_id: exportId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const exportMetadata = project.exports.find((e: any) => e.id.toString() === exportId);

      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found in this project' });
      }

      await deleteExport(config, projectId, exportId, project.dbType, exportMetadata.collectionName);

      res.status(200).json({ message: 'Export deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete export', details: err.message });
    }
  });

  router.get('/:projectId/get-export/:exportName', async (req: Request, res: Response) => {
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

      const origin = req.headers.origin;
      let effectiveAllowedOrigins = exportMetadata.allowedOrigin;
      const projectOrigins = project.allowedOrigin;

      // If export's allowedOrigin is ['*'] or it's not set, it inherits from the project.
      if (!effectiveAllowedOrigins || (effectiveAllowedOrigins.length === 1 && effectiveAllowedOrigins[0] === '*')) {
        effectiveAllowedOrigins = projectOrigins;
      } else {
        // If the export has its own list, ensure it's a subset of the project's list (if project is not public).
        if (projectOrigins && !projectOrigins.includes('*')) {
          const isSubset = effectiveAllowedOrigins.every((o: string) => projectOrigins.includes(o));
          if (!isSubset) {
            return res.status(403).json({ message: 'Unauthorized: Export origins are not allowed by the parent project.' });
          }
        }
      }

      // If there's no origin header, deny access unless the effective scope is public.
      if (!origin && !(effectiveAllowedOrigins && effectiveAllowedOrigins.includes('*'))) {
        return res.status(403).json({ message: 'Origin header required' });
      }

      // Check for public access ('*') or if the request's origin is in the effective list.
      const isAllowed = effectiveAllowedOrigins && (effectiveAllowedOrigins.includes('*') || (origin && effectiveAllowedOrigins.includes(origin)));

      if (!isAllowed) {
        return res.status(403).json({ message: 'Unauthorized' });
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
        } else if (exportMetadata.type === 'externalApi') {
          let headers: Record<string, string> = {};
          if (exportMetadata.credentialId) {
            if (!isEncryptionKeySet()) {
              throw new Error('Encryption key is not set. Cannot use encrypted credentials.');
            }
            const credential = project.credentials?.find((cred: any) => cred.id === exportMetadata.credentialId);
            if (!credential) {
              throw new Error(`Credential with ID ${exportMetadata.credentialId} not found.`);
            }
            const decryptedValue = decrypt(credential.encryptedValue);
            const authPrefix = exportMetadata.prefix ? `${exportMetadata.prefix} ` : '';
            headers = {
              'Authorization': `${authPrefix}${decryptedValue}`,
              'Content-Type': 'application/json',
            };
          }

          try {
            const response = await fetch(exportMetadata.apiUrl, { headers });
            if (!response.ok) {
              throw new Error(`Failed to fetch from external API: ${response.statusText}`);
            }
            data = await response.json();
          } catch (error: any) {
            throw new Error(`Error fetching from external API: ${error.message}`);
          }

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

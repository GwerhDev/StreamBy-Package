import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { createExport, updateExport, deleteExport } from '../../services/export';
import { executePipeline } from '../../services/pipeline';
import { getConnection } from '../../adapters/database/connectionManager';
import { MongoClient, ObjectId } from 'mongodb';
import { decrypt, isEncryptionKeySet } from '../../utils/encryption';

const DEFAULT_NODE_SCHEMA = {
  nodes: [
    {
      id: 'client',
      type: 'clientNode',
      position: { x: 0, y: 100 },
      data: { label: 'Client', subtitle: 'GET' },
      width: 148,
      height: 100,
    },
    {
      id: 'streamby',
      type: 'streambyNode',
      position: { x: 240, y: 100 },
      data: { label: 'StreamBy', subtitle: 'Middleware' },
      width: 158,
      height: 100,
    },
  ],
  edges: [
    {
      id: 'e-client-streamby',
      source: 'client',
      sourceHandle: 'out-right',
      target: 'streamby',
      targetHandle: 'in-left',
      animated: true,
      style: { stroke: '#38B6FF', strokeWidth: 2 },
    },
  ],
};

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
        if (exportMetadata.nodeSchema) {
          data = {
            name: exportMetadata.name,
            description: exportMetadata.description,
            collectionName: exportMetadata.collectionName,
            nodeSchema: exportMetadata.nodeSchema,
            useConnections: exportMetadata.useConnections,
            useCredentials: exportMetadata.useCredentials,
            type: exportMetadata.type,
          };
        } else if (exportMetadata.type === 'json') {
          const rawData = await db.collection(exportMetadata.collectionName).findOne({ _id: new ObjectId(exportId) });
          data = {
            json: rawData?.json,
            name: rawData?.name,
            method: rawData?.method,
            collectionName: rawData?.collectionName,
            createdAt: rawData?.createdAt,
            updatedAt: rawData?.updatedAt,
            type: exportMetadata.type,
            fields: exportMetadata.fields,
            description: rawData?.description,
          };
        } else if (exportMetadata.type === 'externalApi') {
          const ProjectModel = getModel('projects', 'nosql');
          const currentProject = await ProjectModel.findOne({ _id: projectId });

          if (!currentProject) {
            return res.status(404).json({ message: 'Project not found.' });
          }

          let headers: Record<string, string> = {};
          if (exportMetadata.credentialId) {
            if (!isEncryptionKeySet()) {
              throw new Error('Encryption key is not set. Cannot use encrypted credentials.');
            }
            const credential = project.credentials?.find((cred: any) => cred.id === exportMetadata.credentialId);
            if (credential) {
              const decryptedValue = decrypt(credential.encryptedValue);
              const authPrefix = exportMetadata.prefix ? `${exportMetadata.prefix} ` : '';
              headers = {
                'Authorization': `${authPrefix}${decryptedValue}`,
                'Content-Type': 'application/json',
              };
            }
          }

          const externalApiData = await fetch(exportMetadata.apiUrl, { headers });
          const apiResponse = await externalApiData.json();
          let rawData: any;

          if (exportMetadata.fields && exportMetadata.fields.length > 0) {
            rawData = apiResponse.map((item: any) => {
              return exportMetadata.fields.reduce((filtered: any, field: any) => {
                filtered[field.name] = item[field.name];
                return filtered;
              }, {});
            });
          }

          data = {
            apiResponse: apiResponse,
            json: rawData || {},
            name: exportMetadata.name,
            createdAt: exportMetadata.createdAt,
            updatedAt: exportMetadata.updatedAt,
            type: exportMetadata.type,
            apiUrl: exportMetadata.apiUrl,
            prefix: exportMetadata.prefix,
            collectionName: exportMetadata.collectionName,
            fields: exportMetadata.fields,
            description: exportMetadata?.description,
          };

        } else {
          const rawData = await db.collection(exportMetadata.collectionName).findOne({ _id: new ObjectId(exportId) });
          data = {
            json: rawData?.json,
            name: rawData?.name,
            method: rawData?.method,
            createdAt: rawData?.createdAt,
            updatedAt: rawData?.updatedAt,
            collectionName: rawData?.collectionName,
            type: exportMetadata.type,
            credentialId: exportMetadata.credentialId,
            description: rawData?.description,
            fields: exportMetadata.fields,
          };
        }
      } else if (project.dbType === 'sql') {
        // ... SQL implementation needed
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      let responseData: any;
      responseData = {
        ...data,
        allowedOrigin: exportMetadata.allowedOrigin,
        private: exportMetadata.private,
      };

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
      const { name, description, isPrivate, allowedOrigin, useConnections, useCredentials, nodeSchema, storageDbId } = req.body;

      if (!name) {
        return res.status(400).json({ message: 'Missing export name' });
      }

      const resolvedNodeSchema = nodeSchema ?? DEFAULT_NODE_SCHEMA;
      const exportType = useConnections ? 'externalApi' : 'json';

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const mainDb = config.databases?.find(db => db.main) ?? config.databases?.[0];
      const dbType = mainDb?.type ?? 'nosql';

      const result = await createExport(config, projectId, description, name, dbType, exportType, isPrivate, allowedOrigin, resolvedNodeSchema, useConnections, useCredentials, storageDbId);

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
      const { name, description, isPrivate, allowedOrigin, useConnections, useCredentials, nodeSchema } = req.body;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const exportMetadata = project.exports?.find((e: any) => e.id.toString() === exportId);
      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found' });
      }

      const resolvedName = name ?? exportMetadata.name;
      const resolvedNodeSchema = nodeSchema ?? exportMetadata.nodeSchema;
      const resolvedUseConnections = useConnections ?? exportMetadata.useConnections;
      const exportType = resolvedUseConnections ? 'externalApi' : 'json';

      const result = await updateExport(config, projectId, exportId, description ?? exportMetadata.description, resolvedName, project.dbType, exportType, isPrivate ?? exportMetadata.private, allowedOrigin ?? exportMetadata.allowedOrigin, resolvedNodeSchema, resolvedUseConnections, useCredentials ?? exportMetadata.useCredentials);

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

      await deleteExport(config, projectId, exportId, project.dbType, exportMetadata.name);

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

      let data: any;

      if (exportMetadata.nodeSchema) {
        data = await executePipeline(exportMetadata.nodeSchema, project, config);
      } else {

      const targetDb = config.databases?.find(db => db.type === project.dbType);
      if (!targetDb) {
        return res.status(500).json({ message: `Database connection not found for type ${project.dbType}` });
      }

      const connection = getConnection(targetDb.id);

      if (project.dbType === 'nosql') {
        const db = (connection.client as MongoClient).db();
        if (exportMetadata.type === 'json') {
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

          if (exportMetadata.fields && exportMetadata.fields.length > 0) {
            data = data.map((item: any) => {
              return exportMetadata.fields.reduce((filtered: any, field: any) => {
                filtered[field.name] = item[field.name];
                return filtered;
              }, {});
            });
          }
        }
      } else if (project.dbType === 'sql') {
        return res.status(501).json({ message: 'SQL public exports not yet implemented' });
      }

      } // end legacy else block

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      res.json(data);
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch public export data', details: err.message });
    }
  });

  return router;
}

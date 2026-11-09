import { Router, Request, Response } from 'express';
import { addToWorkflow, removeFromWorkflow } from '../../services/workflowResources';
import { deleteDeliverablesOf } from '../../services/deliverables';
import { Auth, StreamByConfig } from '../../types';
import { exportSummaries } from '../../utils/sanitize';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { createExport, updateExport, deleteExport } from '../../services/export';
import { executeExport } from '../../services/executor';
import { getConnection } from '../../adapters/database/connectionManager';
import { MongoClient, ObjectId } from 'mongodb';
import { Pool } from 'pg';
import { decrypt, isEncryptionKeySet } from '../../utils/encryption';
import { buildCatalog, CONTENT_NAME, exclusionMessage, IMMUTABLE_CACHE } from '../../services/deliverableCatalog';
import { projectImageKey, projectImageStorageKey, publicBaseOf, resolveStorageReferences } from '../../services/storageReferences';

export const DEFAULT_NODE_SCHEMA = {
  nodes: [
    {
      id: 'request',
      type: 'requestNode',
      position: { x: 0, y: 100 },
      data: { label: 'Request', subtitle: 'GET' },
      width: 148,
      height: 100,
    },
    {
      id: 'streamby',
      type: 'streambyNode',
      position: { x: 280, y: 100 },
      data: { label: 'StreamBy', subtitle: 'Middleware' },
      width: 158,
      height: 100,
    },
    {
      id: 'response',
      type: 'responseNode',
      position: { x: 560, y: 100 },
      data: { label: 'Response', subtitle: 'HTTP Response' },
      width: 148,
      height: 100,
    },
  ],
  edges: [
    {
      id: 'e-request-streamby',
      source: 'request',
      sourceHandle: 'out-right',
      target: 'streamby',
      targetHandle: 'in-left',
      animated: true,
      style: { stroke: '#38B6FF', strokeWidth: 2 },
    },
    {
      id: 'e-streamby-response',
      source: 'streamby',
      sourceHandle: 'out-right',
      target: 'response',
      targetHandle: 'in-left',
      animated: true,
      style: { stroke: '#fbbf24', strokeWidth: 2 },
    },
  ],
};

export function exportRouter(config: StreamByConfig): Router {
  const router = Router();

  const Project = getModel('projects');

  // ─── A project's exports, on their own ────────────────────────────────────
  router.get('/projects/:id/exports', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      return res.status(200).json({ data: exportSummaries(project.exports) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch exports', details: err.message });
    }
  });

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
          const rawData = await db.collection('exports').findOne({ _id: new ObjectId(exportId) });
          data = {
            json: rawData?.json,
            name: rawData?.name,
            method: rawData?.method,
            createdAt: rawData?.createdAt,
            updatedAt: rawData?.updatedAt,
            type: exportMetadata.type,
            fields: exportMetadata.fields,
            description: rawData?.description,
          };
        } else if (exportMetadata.type === 'externalApi') {
          const ProjectModel = getModel('projects');
          const currentProject = await ProjectModel.findOne({ _id: projectId });

          if (!currentProject) {
            return res.status(404).json({ message: 'Project not found.' });
          }

          let headers: Record<string, string> = {};
          if (exportMetadata.encryptedCredential) {
            if (!isEncryptionKeySet()) {
              throw new Error('Encryption key is not set. Cannot use encrypted credentials.');
            }
            const decryptedValue = decrypt(exportMetadata.encryptedCredential);
            const authPrefix = exportMetadata.prefix ? `${exportMetadata.prefix} ` : '';
            headers = {
              'Authorization': `${authPrefix}${decryptedValue}`,
              'Content-Type': 'application/json',
            };
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
          const rawData = await db.collection('exports').findOne({ _id: new ObjectId(exportId) });
          data = {
            json: rawData?.json,
            name: rawData?.name,
            method: rawData?.method,
            createdAt: rawData?.createdAt,
            updatedAt: rawData?.updatedAt,
            type: exportMetadata.type,
            hasCredential: !!exportMetadata.encryptedCredential,
            description: rawData?.description,
            fields: exportMetadata.fields,
          };
        }
      } else if (project.dbType === 'sql') {
        const pool = connection.client as Pool;
        if (exportMetadata.nodeSchema) {
          data = {
            name: exportMetadata.name,
            description: exportMetadata.description,
            nodeSchema: exportMetadata.nodeSchema,
            useConnections: exportMetadata.useConnections,
            useCredentials: exportMetadata.useCredentials,
            type: exportMetadata.type,
          };
        } else {
          const result = await pool.query(`SELECT * FROM "exports" WHERE id = $1`, [exportId]);
          const rawData = result.rows[0];
          if (rawData) {
            data = {
              json: rawData.json,
              name: rawData.name,
              method: rawData.method,
              createdAt: rawData.created_at,
              updatedAt: rawData.updated_at,
              type: exportMetadata.type,
              fields: exportMetadata.fields,
              description: rawData.description,
            };
          }
        }
      }

      if (!data) {
        return res.status(404).json({ message: 'Export data not found' });
      }

      let responseData: any;
      responseData = {
        ...data,
        id: exportId,
        allowedOrigin: exportMetadata.allowedOrigin,
        private: exportMetadata.private,
        devMode: exportMetadata.devMode,
        devPorts: exportMetadata.devPorts,
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
      if (!project || !canEditProject(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const mainDb = config.databases?.find(db => db.main) ?? config.databases?.[0];
      const dbType = mainDb?.type ?? 'nosql';

      const result = await createExport(config, projectId, description, name, dbType, exportType, isPrivate, allowedOrigin, resolvedNodeSchema, useConnections, useCredentials, storageDbId);
      await addToWorkflow(projectId, 'export', { id: result.exportId, name, method: 'GET' });

      res.status(201).json({ data: result, exports: exportSummaries((await Project.findOne({ _id: projectId }))?.exports), message: result.message });
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
      const { name, description, isPrivate, allowedOrigin, devMode, devPorts, useConnections, useCredentials, nodeSchema } = req.body;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !canEditProject(project, auth.userId)) {
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

      const result = await updateExport(config, projectId, exportId, description ?? exportMetadata.description, resolvedName, project.dbType, exportType, isPrivate ?? exportMetadata.private, allowedOrigin ?? exportMetadata.allowedOrigin, devMode ?? exportMetadata.devMode, devPorts ?? exportMetadata.devPorts, resolvedNodeSchema, resolvedUseConnections, useCredentials ?? exportMetadata.useCredentials);

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
      if (!project || !canEditProject(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const exportMetadata = project.exports.find((e: any) => e.id.toString() === exportId);

      if (!exportMetadata) {
        return res.status(404).json({ message: 'Export not found in this project' });
      }

      await deleteExport(config, projectId, exportId, project.dbType);
      await deleteDeliverablesOf(projectId, { exportId });
      await removeFromWorkflow(projectId, 'export', exportId);

      res.status(200).json({ message: 'Export deleted successfully', exports: exportSummaries((await Project.findOne({ _id: projectId }))?.exports) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete export', details: err.message });
    }
  });

  // A project's export, as its public routes find it: by its name, and only for the origins it
  // (or its project) allows -- or a page in dev mode, on localhost. null once it has answered why not.
  async function publicExport(req: Request, res: Response): Promise<{ project: any; exportMetadata: any } | null> {
    const { projectId, exportName } = req.params;

    const project = await Project.findOne({ _id: projectId });
    if (!project) {
      res.status(404).json({ message: 'Project not found' }); return null;
    }

    const exportMetadata = (project.exports as any[] | undefined)?.find(
      (e: any) => e.name?.toLowerCase().trim() === exportName.toLowerCase().trim(),
    );
    if (!exportMetadata) {
      res.status(404).json({ message: 'Export not found in this project' }); return null;
    }

    const origin = req.headers.origin;
    let effectiveAllowedOrigins = exportMetadata.allowedOrigin;
    const projectOrigins = project.allowedOrigin;

    // If export's allowedOrigin is empty, ['*'], or not set, it inherits from the project.
    if (!effectiveAllowedOrigins || effectiveAllowedOrigins.length === 0 || (effectiveAllowedOrigins.length === 1 && effectiveAllowedOrigins[0] === '*')) {
      effectiveAllowedOrigins = projectOrigins;
    } else {
      if (projectOrigins && !projectOrigins.includes('*')) {
        const isSubset = effectiveAllowedOrigins.every((o: string) => projectOrigins.includes(o));
        if (!isSubset) {
          res.status(403).json({ message: 'Unauthorized: Export origins are not allowed by the parent project.' }); return null;
        }
      }
    }

    // Dev mode: auto-allow localhost requests on configured ports.
    let devModeAllowed = false;
    if (exportMetadata.devMode && origin) {
      const match = origin.match(/^https?:\/\/localhost:(\d+)$/);
      if (match) {
        const port = parseInt(match[1]);
        const allowedPorts: number[] = exportMetadata.devPorts?.length
          ? exportMetadata.devPorts
          : [3000, 5173, 8080, 4200];
        if (allowedPorts.includes(port)) {
          devModeAllowed = true;
          res.header('Access-Control-Allow-Origin', origin);
          res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }
      }
    }

    if (!devModeAllowed) {
      if (!origin && !(effectiveAllowedOrigins && effectiveAllowedOrigins.includes('*'))) {
        res.status(403).json({ message: 'Origin header required' }); return null;
      }

      const isAllowed = effectiveAllowedOrigins && (effectiveAllowedOrigins.includes('*') || (origin && effectiveAllowedOrigins.includes(origin)));

      if (!isAllowed) {
        res.status(403).json({ message: 'Unauthorized' }); return null;
      }
    }

    return { project, exportMetadata };
  }

  // ── An export's catalog (see services/deliverableCatalog) ──

  const adapter = config.adapter;
  // Where the catalog links a content key: the CDN in front of the storage, or the content route.
  const contentUrlFor = (req: Request) => (key: string) => {
    if (config.contentBaseUrl) return `${config.contentBaseUrl.replace(/\/+$/, '')}/${key}`;
    const [projectId, , name] = key.split('/');
    return `${publicBaseOf(req, config)}/${projectId}/content/${name}`;
  };

  const publicCatalog = async (req: Request, res: Response) => {
    const found = await publicExport(req, res);
    if (!found) return null;
    if (!adapter) {
      res.status(501).json({ message: 'No storage to catalog deliverables from' });
      return null;
    }
    const { catalog } = await buildCatalog(found.project, found.exportMetadata, adapter, contentUrlFor(req));
    // Asked again every time (it's cheap with its ETag): it changes when a deliverable does.
    res.setHeader('Cache-Control', 'no-cache');
    return catalog;
  };

  router.get('/:projectId/export/:exportName/catalog.json', async (req: Request, res: Response) => {
    try {
      const catalog = await publicCatalog(req, res);
      if (catalog) res.json(catalog);
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to build the catalog', details: err.message });
    }
  });

  router.get('/:projectId/export/:exportName/catalog.hash', async (req: Request, res: Response) => {
    try {
      const catalog = await publicCatalog(req, res);
      if (catalog) res.type('text/plain').send(catalog.hash);
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to build the catalog', details: err.message });
    }
  });

  // A catalogued content, by its hash: a redirect to the storage. What it serves never changes,
  // and is cached forever; the redirect, for as long as the signed URL it gives is the same.
  router.get('/:projectId/content/:name', async (req: Request, res: Response) => {
    try {
      const { projectId, name } = req.params;
      if (!CONTENT_NAME.test(name)) return res.status(404).json({ message: 'Content not found' });
      if (!adapter?.contentInfo || !adapter.getPresignedGetUrl) return res.status(501).json({ message: 'The storage cannot serve catalogued content' });
      const key = `${projectId}/content/${name}`;
      if (!(await adapter.contentInfo(key))) return res.status(404).json({ message: 'Content not found' });
      const url = await adapter.getPresignedGetUrl(key, 3600, undefined, { stable: true, cacheControl: IMMUTABLE_CACHE });
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.redirect(302, url);
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to serve the content', details: err.message });
    }
  });

  // A project's image: a redirect to a signed URL of it (stable within the hour), as the content
  // route does; the bucket is never read by a URL of its own. Open, as project images always were.
  router.get('/:projectId/image', async (req: Request, res: Response) => {
    try {
      const project = await Project.findOne({ _id: req.params.projectId });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!adapter?.contentInfo || !adapter.getPresignedGetUrl) return res.status(501).json({ message: 'The storage cannot serve project images' });
      const key = projectImageKey(project, adapter) ?? projectImageStorageKey(req.params.projectId);
      if (!(await adapter.contentInfo(key))) return res.status(404).json({ message: 'This project has no image' });
      const url = await adapter.getPresignedGetUrl(key, 3600, undefined, { stable: true, cacheControl: 'public, max-age=3600' });
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.redirect(302, url);
    } catch (err: any) {
      res.status(500).json({ message: "Failed to serve the project's image", details: err.message });
    }
  });

  // The catalog as the export's editors see it: with the deliverables left out of it, and why.
  router.get('/projects/:id/exports/:export_id/catalog', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });
      const exportMeta = (project.exports as any[] | undefined)?.find((e: any) => String(e.id) === req.params.export_id);
      if (!exportMeta) return res.status(404).json({ message: 'Export not found' });
      if (!adapter) return res.status(501).json({ message: 'No storage to catalog deliverables from' });
      const { catalog, excluded } = await buildCatalog(project, exportMeta, adapter, contentUrlFor(req));
      res.json({ catalog, excluded: excluded.map(e => ({ ...e, message: exclusionMessage(e.reason) })) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to build the catalog', details: err.message });
    }
  });

  router.get('/:projectId/export/:exportName', async (req: Request, res: Response) => {
    try {
      const found = await publicExport(req, res);
      if (!found) return;
      const { project, exportMetadata } = found;

      let data: any;

      if (exportMetadata.nodeSchema) {
        // Read without a session: only the nodes that read data run (see executeExport).
        data = await executeExport(exportMetadata.nodeSchema, project, config, { public: true });
        return res.json(await resolveStorageReferences(data ?? null, project, adapter));
      }

      // Legacy path: raw JSON or external API export
      const targetDb = config.databases?.find(db => db.type === project.dbType);
      if (!targetDb) {
        return res.status(500).json({ message: `Database connection not found for type ${project.dbType}` });
      }

      const connection = getConnection(targetDb.id);

      if (project.dbType === 'nosql') {
        const db = (connection.client as MongoClient).db();

        if (exportMetadata.type === 'json') {
          const rawData = await db.collection('exports').findOne({ _id: new ObjectId(exportMetadata.id.toString()) });
          data = rawData ? rawData.json : null;
        } else if (exportMetadata.type === 'externalApi') {
          let headers: Record<string, string> = {};
          if (exportMetadata.encryptedCredential) {
            if (!isEncryptionKeySet()) {
              throw new Error('Encryption key is not set. Cannot use encrypted credentials.');
            }
            const decryptedValue = decrypt(exportMetadata.encryptedCredential);
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

      res.json(await resolveStorageReferences(data ?? null, project, adapter));
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch public export data', details: err.message });
    }
  });

  return router;
}

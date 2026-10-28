import { Router, Request, Response } from 'express';

import { StreamByConfig, NodeSchema } from '../../types';
import { getModel } from '../../models/manager';
import { canEditProject, isProjectMember } from '../../utils/auth';
import { connectIntegration } from '../../services/projectIntegration';
import { addConnection } from '../../services/connection';
import {
  listsOf, migrateSchema, oneNodePerResource, pendingOf, readWorkflow, referencedIn, removeResourceOf, ResourceKind, writeWorkflow,
} from '../../services/workflowResources';

// The integration kind a node's pending connection is of, by the node's type, and its field.
const INTEGRATION_KIND: Record<string, { kind: 'database' | 'storage' | 'service'; field: string }> = {
  dataSourceNode: { kind: 'database', field: 'connectionId' },
  ingestNode: { kind: 'storage', field: 'storageConnectionId' },
  integrationConnectionNode: { kind: 'service', field: 'integrationConnectionId' },
};

export function workflowRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // A project has exactly one Workflow (the central canvas), stored as the single
  // `project.workflow` object. It defines the project: each resource is one of its nodes.
  router.get('/projects/:id/workflow', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const project = await Project.findOne({ _id: req.params.id });
      if (!project) return res.status(404).json({ message: 'Project not found' });
      if (!isProjectMember(project, auth.userId)) return res.status(403).json({ message: 'Unauthorized access' });

      res.json({ data: await readWorkflow(project), message: 'Workflow fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch workflow', details: err.message });
    }
  });

  // Saves the workflow, and makes the project what it defines: a node set to an integration the
  // project doesn't have connects it, a new API node's connection is made, and a resource whose
  // nodes are all gone is removed. Answers the workflow and the project's lists as they are then,
  // and what couldn't be done (its node kept as it was sent).
  router.patch('/projects/:id/workflow', async (req: Request, res: Response) => {
    try {
      const auth = await config.authProvider(req);
      if (!auth?.userId) return res.status(401).json({ message: 'Unauthorized' });

      const projectId = req.params.id;
      let project = await Project.findOne({ _id: projectId });
      if (!project || !canEditProject(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const { name, description, status, nodeSchema, baseUpdatedAt } = req.body;
      // Made on the version it was read at: a change saved since (a resource added from its
      // section, its node with it) would be undone, its resource removed.
      const current = project.workflow?.updatedAt ? new Date(project.workflow.updatedAt).toISOString() : null;
      if (nodeSchema !== undefined && baseUpdatedAt && current && new Date(baseUpdatedAt).toISOString() !== current) {
        return res.status(409).json({ message: 'The workflow changed since it was opened: open it again to see the change.', data: await readWorkflow(project) });
      }
      const changes: Record<string, unknown> = {
        ...(name !== undefined && { name }), ...(description !== undefined && { description }), ...(status !== undefined && { status }),
      };
      const errors: string[] = [];

      if (nodeSchema !== undefined) {
        const before: NodeSchema = project.workflow?.resourceNodesAt
          ? { nodes: project.workflow?.nodeSchema?.nodes ?? [], edges: project.workflow?.nodeSchema?.edges ?? [] }
          : migrateSchema(project, { nodes: project.workflow?.nodeSchema?.nodes ?? [], edges: project.workflow?.nodeSchema?.edges ?? [] });
        const given: NodeSchema = { nodes: Array.isArray(nodeSchema?.nodes) ? nodeSchema.nodes : [], edges: Array.isArray(nodeSchema?.edges) ? nodeSchema.edges : [] };
        // One not brought yet to define the project (see migrateSchema) is, before it's compared:
        // its resources without a node aren't removed for it.
        const sent = project.workflow?.resourceNodesAt ? given : migrateSchema(project, given);

        // What its nodes make: the integrations they were set to, the APIs drafted on them.
        const connected = new Map<string, string>();
        const nodes: any[] = [];
        for (const node of sent.nodes) {
          let data = node?.data ?? {};
          const pending = INTEGRATION_KIND[node?.type];
          const integrationId = pending && pendingOf(data[pending.field]);
          if (pending && integrationId) {
            if (!connected.has(integrationId)) {
              const result = await connectIntegration(await Project.findOne({ _id: projectId }), integrationId, auth, config, { kind: pending.kind });
              if ('error' in result) errors.push(`${data.label ?? integrationId}: ${result.error}`);
              else connected.set(integrationId, result.connection.id);
            }
            if (connected.has(integrationId)) data = { ...data, [pending.field]: connected.get(integrationId) };
          }
          if (node.type === 'connectionNode' && data.connectionDraft && !data.connectionId) {
            try {
              const { name: apiName, apiUrl, method, token, prefix, description: apiDescription } = data.connectionDraft;
              const created = await addConnection(config, projectId, { name: apiName, apiUrl, method: method ?? 'GET', token, prefix, description: apiDescription });
              const { connectionDraft: _draft, ...rest } = data;
              data = { ...rest, connectionId: created.id, label: created.name, subtitle: created.apiUrl };
            } catch (err: any) {
              errors.push(`${data.connectionDraft?.name ?? 'API'}: ${err.message}`);
            }
          }
          nodes.push(data === node?.data ? node : { ...node, data });
        }

        // What its nodes no longer are: a resource bound to a node before, to none now.
        const was = referencedIn(before);
        const is = referencedIn({ nodes, edges: sent.edges });
        project = await Project.findOne({ _id: projectId });
        for (const kind of Object.keys(was) as ResourceKind[]) {
          for (const id of was[kind]) {
            if (is[kind].has(id)) continue;
            try {
              await removeResourceOf(project, kind, id, config);
            } catch (err: any) {
              errors.push(`${id}: ${err.message}`);
            }
          }
        }
        changes.nodeSchema = oneNodePerResource({ nodes, edges: sent.edges });
        changes.resourceNodesAt = project.workflow?.resourceNodesAt ?? new Date();
      }

      const updated = await writeWorkflow(await Project.findOne({ _id: projectId }), changes);
      res.json({ data: updated, project: await listsOf(projectId), errors, message: 'Workflow updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update workflow', details: err.message });
    }
  });

  return router;
}

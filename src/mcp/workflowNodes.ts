import crypto from 'crypto';
import { getModel } from '../models/manager';
import { Auth } from '../types';
import { activeMemberOf } from '../utils/auth';
import { scopeReachesProject } from '../services/auth';
import type { ApiCaller } from './server';
import { readWorkflow } from '../services/workflowResources';

// What a workflow needs before the data that depends on it is made, as a user would do in the
// UI: production data lives under a production node, so a production section is only part of
// the workflow once one is on its canvas. An agent adds it the same way dropping it does.

export type WorkflowNodeRequirement = 'production';

// The node types that make a workflow's production section (as the UI groups them).
const PRODUCTION_NODE_TYPES = new Set(['shotNode', 'assemblyNode', 'masterNode']);

/** A Shot node, as the UI makes one dropped on the canvas without a position. */
export const newShotNode = () => ({
  id: `shotNode-${crypto.randomUUID()}`,
  type: 'shotNode',
  position: { x: 240 + Math.random() * 60, y: 300 + Math.random() * 40 },
  data: { label: 'Shot', subtitle: 'Raw video clip', bgColor: '#0e2537', iconColor: '#38B6FF' },
});

/**
 * Makes sure a project's workflow has what `requirement` needs, adding it (through the REST
 * API, as the caller) if it's missing. An error to answer with, or null to go on. A project
 * the caller doesn't reach is left alone: the call that follows answers for it.
 */
export async function ensureWorkflowNode(
  requirement: WorkflowNodeRequirement,
  projectId: string | undefined,
  auth: Auth,
  api: ApiCaller,
): Promise<string | null> {
  if (requirement !== 'production' || !projectId) return null;
  if (!scopeReachesProject(auth.apiToken, projectId)) return null;
  const project = await getModel('projects').findOne({ _id: projectId });
  if (!project || !activeMemberOf(project, auth.userId)) return null;

  // The workflow as it's answered (brought to define the project, if it wasn't yet), and saved
  // on that version: what changed since isn't undone.
  const workflow = await readWorkflow(project);
  const nodes: any[] = Array.isArray(workflow?.nodeSchema?.nodes) ? workflow.nodeSchema.nodes : [];
  if (nodes.some(node => PRODUCTION_NODE_TYPES.has(node?.type))) return null;

  const answer = await api({
    method: 'PATCH',
    path: `/projects/${encodeURIComponent(projectId)}/workflow`,
    body: {
      nodeSchema: { nodes: [...nodes, newShotNode()], edges: Array.isArray(workflow?.nodeSchema?.edges) ? workflow.nodeSchema.edges : [] },
      baseUpdatedAt: new Date(workflow.updatedAt).toISOString(),
    },
  });
  if (answer.status >= 200 && answer.status < 300) return null;
  const message = (answer.body as any)?.message ?? (answer.body as any)?.error;
  return `Couldn't add a production node to the project's workflow: ${typeof message === 'string' ? message : `StreamBy answered ${answer.status}`}`;
}

import { z } from 'zod';

// The MCP server's tools. Each one is a call to StreamBy's own REST API, made with the
// caller's API token: it reaches exactly what the token and its owner's role in each project
// do, and a write is saved just as one made from the UI.

export interface ToolCall {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  body?: unknown;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  // Writes need a token with write access (and their owner editing the project).
  write: boolean;
  input: S;
  // The project it acts on, when it acts on one (for the audit log).
  projectOf?: (args: z.infer<z.ZodObject<S>>) => string | undefined;
  call: (args: z.infer<z.ZodObject<S>>) => ToolCall;
  // What the response becomes, when only part of it is wanted.
  pick?: (data: any, args: z.infer<z.ZodObject<S>>) => unknown;
}

const tool = <S extends z.ZodRawShape>(definition: ToolDefinition<S>) => definition;

const id = (what: string) => z.string().min(1).describe(`The ${what}'s id`);
const projectId = id('project');
const enc = encodeURIComponent;
const byProject = ({ projectId }: { projectId: string }) => projectId;

const CATEGORIES = ['images', 'audios', 'videos', '3d-models'] as const;

const shotFields = {
  description: z.string().optional(),
  status: z.string().optional().describe('Its status, as the project uses them'),
  assignedTo: z.string().optional().describe("The assignee's user id"),
  assetId: z.string().optional(),
  exportId: z.string().optional(),
  dueDate: z.string().optional().describe('An ISO 8601 date'),
  order: z.number().optional(),
};
const taskFields = {
  status: z.string().optional(),
  priority: z.string().optional(),
  assignedTo: z.string().optional().describe("The assignee's user id"),
  dueDate: z.string().optional().describe('An ISO 8601 date'),
  notes: z.string().optional(),
};
const rightsFields = {
  rightsHolder: z.string().optional(),
  licenseType: z.string().optional().describe('e.g. CC0, CC BY 4.0, proprietary'),
  licenseUrl: z.string().optional(),
  territory: z.string().optional(),
  expiresAt: z.string().optional().describe('An ISO 8601 date'),
  usageRestrictions: z.string().optional(),
  notes: z.string().optional(),
};

// Only the fields given (an unset optional field isn't sent as undefined).
const defined = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export const TOOLS = [
  // ── Reading ──
  tool({
    name: 'list_projects', title: 'List projects', write: false,
    description: 'The StreamBy projects this token reaches.',
    input: {},
    call: () => ({ method: 'GET', path: '/projects' }),
    pick: (data) => data.projects,
  }),
  tool({
    name: 'get_project', title: 'Get a project', write: false,
    description: "A project's details: its name, description, members, exports and connections.",
    input: { projectId },
    projectOf: byProject,
    call: ({ projectId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}` }),
  }),
  tool({
    name: 'list_assets', title: 'List assets', write: false,
    description: "A project's assets of a category (images, audios, videos, 3d-models), optionally in one storage connection, and optionally only those whose name contains `query`.",
    input: {
      projectId,
      category: z.enum(CATEGORIES),
      connectionId: z.string().optional().describe("A storage connection's id; the project's built-in storage if not given"),
      query: z.string().optional().describe('Only assets whose name contains it (case-insensitive)'),
    },
    projectOf: byProject,
    call: ({ projectId, category, connectionId }) => ({
      method: 'GET',
      path: connectionId
        ? `/projects/${enc(projectId)}/connections/storage/${enc(connectionId)}/files/${category}`
        : `/projects/${enc(projectId)}/storage/${category}`,
    }),
    pick: (data, { query }) => {
      const files: any[] = Array.isArray(data?.data) ? data.data : [];
      if (!query) return files;
      const q = query.toLowerCase();
      return files.filter(f => [f.name, f.displayName, f.originalName, f.fileName]
        .some(n => typeof n === 'string' && n.toLowerCase().includes(q)));
    },
  }),
  tool({
    name: 'get_asset_metadata', title: "Get an asset's metadata", write: false,
    description: "An asset's metadata (technical data and custom tags).",
    input: { projectId, fileId: id('asset') },
    projectOf: byProject,
    call: ({ projectId, fileId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/assets/${enc(fileId)}/metadata` }),
  }),
  tool({
    name: 'get_asset_rights', title: "Get an asset's rights", write: false,
    description: "An asset's rights: holder, license, territory, expiry and restrictions.",
    input: { projectId, assetId: id('asset') },
    projectOf: byProject,
    call: ({ projectId, assetId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/assets/${enc(assetId)}/rights` }),
  }),
  tool({
    name: 'get_workflow', title: "Get a project's workflow", write: false,
    description: "A project's workflow (its node graph).",
    input: { projectId },
    projectOf: byProject,
    call: ({ projectId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/workflow` }),
  }),
  tool({
    name: 'list_pipelines', title: 'List pipelines', write: false,
    description: "A project's pipelines.",
    input: { projectId },
    projectOf: byProject,
    call: ({ projectId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/pipelines` }),
  }),
  tool({
    name: 'get_pipeline', title: 'Get a pipeline', write: false,
    description: 'A pipeline, with its node schema.',
    input: { projectId, pipelineId: id('pipeline') },
    projectOf: byProject,
    call: ({ projectId, pipelineId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}` }),
  }),
  tool({
    name: 'list_exports', title: 'List exports', write: false,
    description: "A project's exports (its published endpoints).",
    input: { projectId },
    projectOf: byProject,
    call: ({ projectId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}` }),
    pick: (data) => data?.project?.exports ?? data?.exports ?? [],
  }),
  tool({
    name: 'get_export', title: 'Get an export', write: false,
    description: 'An export, with its node schema.',
    input: { projectId, exportId: id('export') },
    projectOf: byProject,
    call: ({ projectId, exportId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/exports/${enc(exportId)}` }),
  }),
  tool({
    name: 'get_job', title: 'Get a job', write: false,
    description: "A job's status and progress (transcoding, rendering, ingesting...).",
    input: { jobId: id('job') },
    call: ({ jobId }) => ({ method: 'GET', path: `/jobs/${enc(jobId)}` }),
  }),
  tool({
    name: 'list_sequences', title: 'List production sequences', write: false,
    description: "A project's production sequences.",
    input: { projectId },
    projectOf: byProject,
    call: ({ projectId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/production/sequences` }),
  }),
  tool({
    name: 'list_shots', title: 'List shots', write: false,
    description: "A production sequence's shots.",
    input: { projectId, sequenceId: id('sequence') },
    projectOf: byProject,
    call: ({ projectId, sequenceId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/production/sequences/${enc(sequenceId)}/shots` }),
  }),
  tool({
    name: 'list_tasks', title: 'List shot tasks', write: false,
    description: "A shot's tasks.",
    input: { projectId, shotId: id('shot') },
    projectOf: byProject,
    call: ({ projectId, shotId }) => ({ method: 'GET', path: `/projects/${enc(projectId)}/production/shots/${enc(shotId)}/tasks` }),
  }),

  // ── Writing ──
  tool({
    name: 'update_asset_metadata', title: "Update an asset's custom tags", write: true,
    description: "Sets an asset's custom tags (key/value pairs), replacing the ones it had.",
    input: { projectId, fileId: id('asset'), customTags: z.record(z.string(), z.string()) },
    projectOf: byProject,
    call: ({ projectId, fileId, customTags }) => ({ method: 'PATCH', path: `/projects/${enc(projectId)}/assets/${enc(fileId)}/metadata`, body: { customTags } }),
  }),
  tool({
    name: 'set_asset_rights', title: "Set an asset's rights", write: true,
    description: "Sets an asset's rights: holder, license, territory, expiry, restrictions and notes.",
    input: { projectId, assetId: id('asset'), ...rightsFields },
    projectOf: byProject,
    call: ({ projectId, assetId, ...rights }) => ({ method: 'PUT', path: `/projects/${enc(projectId)}/assets/${enc(assetId)}/rights`, body: defined(rights) }),
  }),
  tool({
    name: 'create_pipeline', title: 'Create a pipeline', write: true,
    description: 'Creates a pipeline in a project.',
    input: { projectId, name: z.string().min(1), description: z.string().optional(), order: z.number().optional() },
    projectOf: byProject,
    call: ({ projectId, ...fields }) => ({ method: 'POST', path: `/projects/${enc(projectId)}/pipelines`, body: defined(fields) }),
  }),
  tool({
    name: 'update_pipeline', title: 'Update a pipeline', write: true,
    description: "Changes a pipeline's name, description or order.",
    input: { projectId, pipelineId: id('pipeline'), name: z.string().min(1).optional(), description: z.string().optional(), order: z.number().optional() },
    projectOf: byProject,
    call: ({ projectId, pipelineId, ...fields }) => ({ method: 'PATCH', path: `/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}`, body: defined(fields) }),
  }),
  tool({
    name: 'create_sequence', title: 'Create a production sequence', write: true,
    description: 'Creates a production sequence in a project.',
    input: { projectId, name: z.string().min(1), description: z.string().optional(), order: z.number().optional() },
    projectOf: byProject,
    call: ({ projectId, ...fields }) => ({ method: 'POST', path: `/projects/${enc(projectId)}/production/sequences`, body: defined(fields) }),
  }),
  tool({
    name: 'update_sequence', title: 'Update a production sequence', write: true,
    description: "Changes a sequence's name, description or order.",
    input: { projectId, sequenceId: id('sequence'), name: z.string().min(1).optional(), description: z.string().optional(), order: z.number().optional() },
    projectOf: byProject,
    call: ({ projectId, sequenceId, ...fields }) => ({ method: 'PATCH', path: `/projects/${enc(projectId)}/production/sequences/${enc(sequenceId)}`, body: defined(fields) }),
  }),
  tool({
    name: 'create_shot', title: 'Create a shot', write: true,
    description: 'Creates a shot in a production sequence.',
    input: { projectId, sequenceId: id('sequence'), name: z.string().min(1), ...shotFields },
    projectOf: byProject,
    call: ({ projectId, sequenceId, ...fields }) => ({ method: 'POST', path: `/projects/${enc(projectId)}/production/sequences/${enc(sequenceId)}/shots`, body: defined(fields) }),
  }),
  tool({
    name: 'update_shot', title: 'Update a shot', write: true,
    description: 'Changes a shot (its name, status, assignee, due date...).',
    input: { projectId, shotId: id('shot'), name: z.string().min(1).optional(), ...shotFields },
    projectOf: byProject,
    call: ({ projectId, shotId, ...fields }) => ({ method: 'PATCH', path: `/projects/${enc(projectId)}/production/shots/${enc(shotId)}`, body: defined(fields) }),
  }),
  tool({
    name: 'create_task', title: 'Create a shot task', write: true,
    description: 'Creates a task in a shot.',
    input: { projectId, shotId: id('shot'), name: z.string().min(1), ...taskFields },
    projectOf: byProject,
    call: ({ projectId, shotId, ...fields }) => ({ method: 'POST', path: `/projects/${enc(projectId)}/production/shots/${enc(shotId)}/tasks`, body: defined(fields) }),
  }),
  tool({
    name: 'update_task', title: 'Update a shot task', write: true,
    description: 'Changes a task (its name, status, priority, assignee, due date, notes).',
    input: { projectId, shotId: id('shot'), taskId: id('task'), name: z.string().min(1).optional(), ...taskFields },
    projectOf: byProject,
    call: ({ projectId, shotId, taskId, ...fields }) => ({ method: 'PATCH', path: `/projects/${enc(projectId)}/production/shots/${enc(shotId)}/tasks/${enc(taskId)}`, body: defined(fields) }),
  }),
] as ToolDefinition<any>[];

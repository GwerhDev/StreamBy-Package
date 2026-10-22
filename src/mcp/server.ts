import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Auth, StreamByConfig } from '../types';
import { TOOLS, ToolCall } from './tools';
import { recordMcpCall } from './audit';
import { ensureWorkflowNode } from './workflowNodes';

export const MCP_SERVER_NAME = 'streamby';

// Makes a call to StreamBy's REST API as the MCP request's caller (their Authorization header):
// the answer's status and parsed body.
export type ApiCaller = (call: ToolCall) => Promise<{ status: number; body: unknown }>;

const errorText = (body: unknown, status: number) => {
  const message = (body as any)?.message ?? (body as any)?.error;
  return typeof message === 'string' ? message : `StreamBy answered ${status}`;
};

/** The tools an API token may use: those whose every permission it has. */
export const toolsFor = (scope: Auth['apiToken']) =>
  TOOLS.filter(tool => tool.permissions.every(p => !!scope?.permissions.includes(p)));

/**
 * An MCP server for one request made with an API token (`auth`): only the tools its permissions
 * allow. Each tool call goes to the REST API through `api`, and is recorded in the audit log.
 */
export function createMcpServer(auth: Auth, api: ApiCaller, config: StreamByConfig, version: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });
  // A project's token acts on its project: what it does there is the project's.
  const tokenProject = auth.apiToken?.kind === 'project' && Array.isArray(auth.apiToken.projectIds)
    ? auth.apiToken.projectIds[0] ?? null
    : null;

  for (const tool of toolsFor(auth.apiToken)) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: !tool.write, destructiveHint: !!tool.destructive, openWorldHint: false },
    }, async (args: any) => {
      const started = Date.now();
      const projectId = tool.projectOf?.(args) ?? tokenProject;
      let status: number | null = null;
      try {
        // What the workflow needs first, as a user would add it.
        if (tool.workflowNode) {
          const refused = await ensureWorkflowNode(tool.workflowNode, tool.projectOf?.(args), auth, api);
          if (refused) {
            await recordMcpCall({
              userId: auth.userId, tokenId: auth.apiToken!.tokenId, projectId, tool: tool.name,
              ok: false, status: null, error: refused, durationMs: Date.now() - started,
            }, config);
            return { isError: true, content: [{ type: 'text' as const, text: refused }] };
          }
        }
        const answer = await api(tool.call(args));
        status = answer.status;
        const ok = status >= 200 && status < 300;
        await recordMcpCall({
          userId: auth.userId, tokenId: auth.apiToken!.tokenId, projectId, tool: tool.name,
          ok, status, error: ok ? null : errorText(answer.body, status), durationMs: Date.now() - started,
        }, config);
        if (!ok) return { isError: true, content: [{ type: 'text' as const, text: errorText(answer.body, status) }] };
        const result = tool.pick ? tool.pick(answer.body, args) : answer.body;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordMcpCall({
          userId: auth.userId, tokenId: auth.apiToken!.tokenId, projectId, tool: tool.name,
          ok: false, status, error: message, durationMs: Date.now() - started,
        }, config);
        return { isError: true, content: [{ type: 'text' as const, text: `The call failed: ${message}` }] };
      }
    });
  }
  return server;
}

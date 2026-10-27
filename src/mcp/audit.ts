import crypto from 'crypto';
import { getModel } from '../models/manager';
import { Auth, StreamByConfig } from '../types';

// Every MCP tool call, kept: who (the token, and its owner -- a project's token is its own
// principal, on its project; an app the user signed in to, by its OAuth client, in place of a
// token), on which project, which tool, and how it went. Never its arguments' values nor the
// token itself.
export interface McpAuditEntry {
  userId: string;
  tokenId: string | null;
  oauthClientId: string | null;
  projectId: string | null;
  tool: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

/** Who made an MCP request, as the audit log keeps it. */
export const auditCallerOf = (auth: Auth): Pick<McpAuditEntry, 'userId' | 'tokenId' | 'oauthClientId'> => ({
  userId: auth.userId,
  tokenId: auth.oauth ? null : auth.apiToken?.tokenId ?? null,
  oauthClientId: auth.oauth?.clientId ?? null,
});

export async function recordMcpCall(entry: McpAuditEntry, config: StreamByConfig): Promise<void> {
  try {
    const dbType = config.databases?.find(db => db.main)?.type ?? 'nosql';
    await getModel('mcp_audit').create({ id: crypto.randomUUID(), ...entry, createdAt: new Date(), dbType } as any);
  } catch (err) {
    console.error('❌ StreamBy MCP: failed to record a tool call:', err instanceof Error ? err.message : err);
  }
}

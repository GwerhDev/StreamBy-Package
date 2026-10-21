import crypto from 'crypto';
import { getModel } from '../models/manager';
import { StreamByConfig } from '../types';

// Every MCP tool call, kept: who (the token's owner and the token), on which project, which
// tool, and how it went. Never its arguments' values nor the token itself.
export interface McpAuditEntry {
  userId: string;
  tokenId: string;
  projectId: string | null;
  tool: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export async function recordMcpCall(entry: McpAuditEntry, config: StreamByConfig): Promise<void> {
  try {
    const dbType = config.databases?.find(db => db.main)?.type ?? 'nosql';
    await getModel('mcp_audit').create({ id: crypto.randomUUID(), ...entry, createdAt: new Date(), dbType } as any);
  } catch (err) {
    console.error('❌ StreamBy MCP: failed to record a tool call:', err instanceof Error ? err.message : err);
  }
}

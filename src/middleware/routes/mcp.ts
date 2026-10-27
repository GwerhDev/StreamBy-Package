import { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Auth, StreamByConfig } from '../../types';
import { createMcpServer, ApiCaller } from '../../mcp/server';
import { createRateLimiter, DEFAULT_MCP_RATE_LIMIT } from '../../mcp/rateLimit';
import { wwwAuthenticate } from '../../services/oauthTokens';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../../../package.json') as { version: string };

const jsonRpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

// StreamBy's MCP server (Streamable HTTP, stateless: one server per request), for agents
// working with StreamBy through an API token, or an OAuth access token of an app the user
// signed in to (e.g. claude.ai's connector). Each tool calls the REST API right here -- this
// same process, under the same mount -- with the request's own Authorization header, so it
// reaches what the token and its owner can and nothing more.
export function mcpRouter(config: StreamByConfig): Router {
  const router = Router();
  const limiter = createRateLimiter(config.mcp?.rateLimit ?? DEFAULT_MCP_RATE_LIMIT);

  router.post('/mcp', async (req: Request, res: Response) => {
    const auth = (req as any).auth as Auth;
    // A browser session isn't for agents: they come with a token.
    if (!auth.apiToken) {
      if (config.oauth) res.setHeader('WWW-Authenticate', wwwAuthenticate(config.oauth, false));
      return jsonRpcError(res, 401, 'The MCP server takes an API token (Authorization: Bearer sbt_...) or an OAuth access token');
    }

    // Per token; an app is counted per user it acts for.
    const taken = limiter.take(auth.apiToken.tokenId);
    if (!taken.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(taken.retryAfterMs / 1000)));
      return jsonRpcError(res, 429, 'Too many requests for this token; try again later');
    }

    const base = config.mcp?.apiBaseUrl ?? `http://127.0.0.1:${req.socket.localPort}${req.baseUrl}`;
    const api: ApiCaller = async ({ method, path, body }) => {
      const answer = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: req.headers.authorization ?? '', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
      });
      const text = await answer.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: answer.status, body: parsed };
    };

    const server = createMcpServer(auth, api, config, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
    } catch (err) {
      console.error('❌ StreamBy MCP: request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal error');
    }
  });

  // Stateless: no session to stream to, nor to end.
  router.get('/mcp', (_req, res) => jsonRpcError(res, 405, 'Method not allowed'));
  router.delete('/mcp', (_req, res) => jsonRpcError(res, 405, 'Method not allowed'));

  return router;
}

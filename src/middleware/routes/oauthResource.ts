import { Router, Request, Response } from 'express';
import { StreamByConfig } from '../../types';
import { protectedResourceMetadata } from '../../services/oauthTokens';

// StreamBy's metadata as an OAuth protected resource (RFC 9728), open to anyone: an MCP client
// that got a 401 reads it to know which authorization server to sign the user in with. The
// host serves the same document at its root too, where RFC 9728 puts it.
export function oauthResourceRouter(config: StreamByConfig): Router {
  const router = Router();

  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    if (!config.oauth) return res.status(404).json({ error: 'Not an OAuth protected resource' });
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
    return res.json(protectedResourceMetadata(config.oauth));
  });

  return router;
}

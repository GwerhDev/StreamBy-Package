import { Request, Response, NextFunction } from 'express';
import { Auth, StreamByConfig } from '../types';

// The one route open without a session: a project's public export, read
// (GET /:projectId/export/:exportName, see routes/export). Exactly that path -- not any path
// that has an "export" segment somewhere.
const PUBLIC_EXPORT = /^\/[^/]+\/export\/[^/]+\/?$/;
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export const isPublicRoute = (method: string, path: string): boolean =>
  READ_METHODS.includes(method.toUpperCase()) && PUBLIC_EXPORT.test(path);

// ── API tokens ──
// A request made with an API token reaches only what the token's scope does: no writes with a
// read token, no project outside its projects (as if it didn't exist), no managing tokens, and
// of the routes outside a project only the few below. Its owner's role in each project still
// decides on top (the routes' own checks).

// The project a route acts on, by its path.
const PROJECT_PATHS = [/^\/projects\/([^/]+)/, /^\/(?:upload|delete)-project-image-url\/([^/]+)/];
const NOT_A_PROJECT = new Set(['create', 'explore']);
const projectIdOf = (path: string): string | undefined => {
  for (const pattern of PROJECT_PATHS) {
    const id = pattern.exec(path)?.[1];
    if (id && !NOT_A_PROJECT.has(id)) return decodeURIComponent(id);
  }
  return undefined;
};

// Outside a project, a token reaches only these reads (each limited to its scope there).
const OUTSIDE_A_PROJECT = [/^\/auth\/?$/, /^\/projects\/?$/, /^\/jobs\/[^/]+\/?$/, /^\/user\/subscription\/?$/, /^\/users\/search\/?$/];

/** Whether a token's scope reaches a project. */
export const scopeReachesProject = (scope: Auth['apiToken'], projectId: string): boolean =>
  !scope || scope.projectIds === '*' || scope.projectIds.includes(projectId);

export const enforceApiTokenScope = (req: Request, res: Response, next: NextFunction) => {
  const scope = ((req as any).auth as Auth | undefined)?.apiToken;
  if (!scope) return next();
  // The MCP server handles a token itself: its tools call the routes here, each one checked.
  if (req.path === '/mcp') return next();
  if (/^\/user\/api-tokens(\/|$)/.test(req.path)) {
    return res.status(403).json({ error: 'API tokens are managed with a session, not with a token' });
  }
  if (!READ_METHODS.includes(req.method.toUpperCase()) && scope.access !== 'write') {
    return res.status(403).json({ error: 'This API token can only read' });
  }
  const projectId = projectIdOf(req.path);
  if (projectId) {
    return scopeReachesProject(scope, projectId) ? next() : res.status(404).json({ message: 'Project not found' });
  }
  if (READ_METHODS.includes(req.method.toUpperCase()) && OUTSIDE_A_PROJECT.some(route => route.test(req.path))) return next();
  return res.status(403).json({ error: 'Not available with an API token' });
};

export const authenticate = (config: StreamByConfig) => async (req: Request, res: Response, next: NextFunction) => {
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  try {
    const auth = await config.authProvider(req);
    if (!auth || !auth.userId || !auth.role) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    (req as any).auth = auth;
    next();
  } catch (error) {
    console.error('Authentication failed:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};



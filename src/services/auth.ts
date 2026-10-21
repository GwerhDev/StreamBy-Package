import { Request, Response, NextFunction } from 'express';
import { Auth, StreamByConfig } from '../types';
import { isProjectTokenPrincipal } from '../utils/auth';
import { ApiTokenPermission, routeRuleFor } from './apiTokenPermissions';

// The one route open without a session: a project's public export, read
// (GET /:projectId/export/:exportName, see routes/export). Exactly that path -- not any path
// that has an "export" segment somewhere.
const PUBLIC_EXPORT = /^\/[^/]+\/export\/[^/]+\/?$/;
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export const isPublicRoute = (method: string, path: string): boolean =>
  READ_METHODS.includes(method.toUpperCase()) && PUBLIC_EXPORT.test(path);

// ── API tokens ──
// A request made with an API token reaches only what the token does: its route's permission
// must be among the token's (see apiTokenPermissions), and a project outside its projects is as
// if it didn't exist. A user's token is also limited by its user's role in each project (the
// routes' own checks); a project's token acts in its project as an admin, so its permissions
// are all it has.

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

/** Whether a token reaches a project. */
export const scopeReachesProject = (scope: Auth['apiToken'], projectId: string): boolean =>
  !scope || scope.projectIds === '*' || scope.projectIds.includes(projectId);

/** Whether a token has a permission (a request without a token: always). */
export const tokenAllows = (scope: Auth['apiToken'], permission: ApiTokenPermission): boolean =>
  !scope || scope.permissions.includes(permission);

export const enforceApiTokenScope = (req: Request, res: Response, next: NextFunction) => {
  const scope = ((req as any).auth as Auth | undefined)?.apiToken;
  if (!scope) return next();
  // The MCP server handles a token itself: its tools call the routes here, each one checked.
  if (req.path === '/mcp') return next();

  const rule = routeRuleFor(req.method, req.path);
  if (!rule || (rule.userTokenOnly && scope.kind !== 'user')) {
    return res.status(403).json({ error: 'Not available with an API token' });
  }
  const projectId = projectIdOf(req.path);
  if (projectId && !scopeReachesProject(scope, projectId)) return res.status(404).json({ message: 'Project not found' });
  if (rule.permission && !tokenAllows(scope, rule.permission)) {
    return res.status(403).json({ error: `This API token doesn't have the '${rule.permission}' permission` });
  }
  next();
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
    // A project token's principal is only ever a project's token (see utils/auth).
    if (isProjectTokenPrincipal(auth.userId) && auth.apiToken?.kind !== 'project') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    (req as any).auth = auth;
    next();
  } catch (error) {
    console.error('Authentication failed:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};



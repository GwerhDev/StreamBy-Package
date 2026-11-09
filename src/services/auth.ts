import { Request, Response, NextFunction } from 'express';
import { Auth, StreamByConfig } from '../types';
import { isProjectTokenPrincipal, projectRoleOf } from '../utils/auth';
import { ApiTokenPermission, routeRuleFor } from './apiTokenPermissions';
import { appAddsFor, memberMay, RoleAction, ROLE_ACTIONS } from './projectPermissions';
import { getModel } from '../models/manager';
import { wwwAuthenticate } from './oauthTokens';

// The routes open without a session, read: a project's public export
// (GET /:projectId/export/:exportName, see routes/export), its catalog (…/catalog.json and
// …/catalog.hash), the content its catalog links to (GET /:projectId/content/<sha256>), and the
// project's image (GET /:projectId/image).
// Exactly those paths -- not any path that has an "export" segment somewhere.
const PUBLIC_PATHS = [
  /^\/[^/]+\/export\/[^/]+\/?$/,
  /^\/[^/]+\/export\/[^/]+\/catalog\.(?:json|hash)$/,
  /^\/[^/]+\/content\/[0-9a-f]{64}(?:\.[a-z0-9]{1,16})?$/,
  /^\/[^/]+\/image$/,
];
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export const isPublicRoute = (method: string, path: string): boolean =>
  READ_METHODS.includes(method.toUpperCase()) && PUBLIC_PATHS.some(p => p.test(path));

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

// ── OAuth apps ──
// An app the user signed in to was approved to make and change things, never to delete them:
// its permissions come from its scopes, and some of those (project:update, workflow:write,
// exports:write) also reach routes that delete (a connection, a worker, an integration, a
// pipeline, an export). So an app's DELETE is refused, unless its route's permission is one its
// project added for its apps (docs:delete, say: see projectPermissions).
// The one DELETE it may always make is taking a deliverable's mark off: that forgets the mark
// only (the asset, its versions and its files stay, and it can be marked again), and it's the
// counterpart of marking one, which assets:write already allows.
const OAUTH_DELETE_ALLOWED = new RegExp(`^/projects/[^/]+/deliverables/[^/]+/?$`);

/** Whether an app (an OAuth request) may make this request's method on its path (`added`: what its project adds for apps). */
export const oauthMayDelete = (method: string, path: string, added: string[] = []): boolean => {
  if (method.toUpperCase() !== 'DELETE' || OAUTH_DELETE_ALLOWED.test(path)) return true;
  const permission = routeRuleFor(method, path)?.permission;
  return !!permission && added.includes(permission);
};

// Nor does an app publish: what it edits stays a draft until someone publishes it. Publishing
// is choosing a document's version for its exports (POST .../publish) or whether they deliver
// it (`exportable`). Refused whatever its scopes grant, as deleting is.
const DOCUMENT_PUBLISH = /^\/projects\/[^/]+\/documents\/[^/]+\/publish\/?$/;
const DOCUMENT = /^\/projects\/[^/]+\/documents\/[^/]+\/?$/;

/** Whether a request publishes a document (its version, or whether it's exported). */
export const publishesDocument = (method: string, path: string, body: unknown): boolean => {
  const upper = method.toUpperCase();
  if (upper === 'POST' && DOCUMENT_PUBLISH.test(path)) return true;
  return upper === 'PATCH' && DOCUMENT.test(path) && typeof body === 'object' && body !== null && 'exportable' in body;
};

export const enforceApiTokenScope = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = (req as any).auth as Auth | undefined;
    const scope = auth?.apiToken;
    if (!scope) return next();
    // The MCP server handles a token itself: its tools call the routes here, each one checked.
    if (req.path === '/mcp') return next();
    const projectId = projectIdOf(req.path);
    // What the project adds for the apps acting in it (none outside a project).
    const added: string[] = await appAddsFor(auth, projectId);
    if (auth?.oauth && !oauthMayDelete(req.method, req.path, added)) {
      return res.status(403).json({ error: 'An app connected with OAuth can\'t delete here: the project doesn\'t let its apps' });
    }
    if (auth?.oauth && publishesDocument(req.method, req.path, req.body) && !added.includes('docs:publish')) {
      return res.status(403).json({ error: 'An app connected with OAuth can\'t publish: what it edits stays a draft' });
    }

    const rule = routeRuleFor(req.method, req.path);
    if (!rule || (rule.userTokenOnly && scope.kind !== 'user')) {
      return res.status(403).json({ error: 'Not available with an API token' });
    }
    if (projectId && !scopeReachesProject(scope, projectId)) return res.status(404).json({ message: 'Project not found' });
    const allowed = rule.permission && (tokenAllows(scope, rule.permission) || (auth?.oauth && added.includes(rule.permission)));
    if (rule.permission && !allowed) {
      return res.status(403).json({ error: `This API token doesn't have the '${rule.permission}' permission` });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ── Roles ──
// What a project's members may do is their role's, as the project sets it (see
// projectPermissions): checked here for every request on a project, whatever made it (a session,
// a token, an app), before its route. So an app or a token never does more in a project than
// its user's role there allows. A route's own checks still apply: the ones that go further than
// the defaults (managing teams, an action of its own for a role) read the project's permissions
// themselves.

/** What a request asks of its user's role in its project, if anything it can be refused. */
export function roleActionFor(method: string, path: string): RoleAction | undefined {
  const rule = routeRuleFor(method, path);
  // About its user only (archiving a project in their own list): not the project's to refuse.
  if (!rule || rule.userTokenOnly) return undefined;
  return (ROLE_ACTIONS as readonly string[]).includes(rule.permission ?? '') ? rule.permission as RoleAction : undefined;
}

export const enforceProjectRoles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = (req as any).auth as Auth | undefined;
    const projectId = projectIdOf(req.path);
    const action = roleActionFor(req.method, req.path);
    if (!auth || !projectId || !action || req.path === '/mcp') return next();
    const project = await getModel('projects').findOne({ _id: projectId });
    const role = projectRoleOf(project, auth.userId);
    // Not a member (or no such project): its route answers that.
    if (!role || role === 'admin') return next();
    if (!(await memberMay(projectId, role, auth.userId, action))) {
      return res.status(403).json({ message: `A ${role} of this project doesn't have the permission to do that here (${action})` });
    }
    next();
  } catch (err) {
    next(err);
  }
};

const hasBearer = (req: Request) => /^Bearer\s+\S/i.test(req.headers.authorization ?? '');

export const authenticate = (config: StreamByConfig) => async (req: Request, res: Response, next: NextFunction) => {
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  // A client without a valid token is told where to sign in (RFC 9728), when StreamBy is set
  // up as an OAuth resource.
  const unauthorized = () => {
    if (config.oauth) res.setHeader('WWW-Authenticate', wwwAuthenticate(config.oauth, hasBearer(req)));
    return res.status(401).json({ error: 'Unauthorized' });
  };

  try {
    const auth = await config.authProvider(req);
    if (!auth || !auth.userId || !auth.role) return unauthorized();
    // A project token's principal is only ever a project's token (see utils/auth).
    if (isProjectTokenPrincipal(auth.userId) && auth.apiToken?.kind !== 'project') return unauthorized();
    // An app acting for the user reaches only what its scopes grant: never without them.
    if (auth.oauth && auth.apiToken?.kind !== 'user') return unauthorized();
    (req as any).auth = auth;
    next();
  } catch (error) {
    console.error('Authentication failed:', error instanceof Error ? error.message : error);
    return unauthorized();
  }
};



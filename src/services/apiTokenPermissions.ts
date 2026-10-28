// What an API token may do: a list of permissions, each a resource and an action. A request
// made with a token goes through only when its route's permission is among the token's (see
// enforceApiTokenScope), and a route without one isn't reachable with a token at all.

/** Permissions on a project, for the projects a token reaches. */
export const PROJECT_PERMISSIONS = [
  'project:read', 'project:update', 'project:delete',
  'members:read', 'members:manage',
  'assets:read', 'assets:write', 'assets:delete',
  'production:read', 'production:write', 'production:delete',
  'workflow:read', 'workflow:write',
  'exports:read', 'exports:write',
  'rights:read', 'rights:write',
  'jobs:read', 'jobs:run',
  'docs:read', 'docs:write', 'docs:publish', 'docs:delete',
] as const;

/** Permissions on the account: only a user's token has them. */
export const ACCOUNT_PERMISSIONS = ['projects:create'] as const;

export type ProjectPermission = typeof PROJECT_PERMISSIONS[number];
export type AccountPermission = typeof ACCOUNT_PERMISSIONS[number];
export type ApiTokenPermission = ProjectPermission | AccountPermission;

export const isProjectPermission = (value: unknown): value is ProjectPermission =>
  (PROJECT_PERMISSIONS as readonly unknown[]).includes(value);
export const isAccountPermission = (value: unknown): value is AccountPermission =>
  (ACCOUNT_PERMISSIONS as readonly unknown[]).includes(value);

// ── Routes ──

/** What a route needs of a token: a permission, or only being a token (`null`). */
export interface RouteRule {
  permission: ApiTokenPermission | null;
  // Only a user's token: the route is about its user (their plan, archiving a project in their
  // own list), and a project's token isn't one.
  userTokenOnly?: boolean;
}

const READ = ['GET', 'HEAD', 'OPTIONS'];
type Methods = 'read' | 'write' | 'delete' | string[];
const methodsOf = (methods: Methods): string[] =>
  methods === 'read' ? READ : methods === 'write' ? ['POST', 'PUT', 'PATCH'] : methods === 'delete' ? ['DELETE'] : methods;

// A project's own path (not /projects/create nor /projects/explore).
const P = '^/projects/(?!(?:create|explore)/?$)[^/]+';
const rule = (methods: Methods, path: string, permission: ApiTokenPermission | null, extra: Omit<RouteRule, 'permission'> = {}) =>
  ({ methods: methodsOf(methods), pattern: new RegExp(`${path}/?$`), permission, ...extra });

// The first rule that matches a request decides it; a request no rule matches is refused.
// Connections, integrations and allowed origins are the project's settings (project:*);
// reviews, QC reports and dependency graphs are of its assets; pipelines are workflow.
const RULES = [
  // Outside a project.
  rule('read', '^/auth', null),
  rule('read', '^/projects', null),
  rule(['POST'], '^/projects/create', 'projects:create'),
  rule('read', '^/user/subscription', null, { userTokenOnly: true }),
  rule('read', '^/users/search', 'members:manage'),
  rule('read', '^/jobs/[^/]+', 'jobs:read'),

  // The project itself and its settings.
  rule('read', `${P}(/preview|/origins|/integrations)?`, 'project:read'),
  rule(['PATCH'], P, 'project:update'),
  rule('delete', P, 'project:delete'),
  rule(['PATCH'], `${P}/(archive|unarchive)`, 'project:update', { userTokenOnly: true }),
  rule(['POST'], `${P}/image`, 'project:update'),
  rule(['PATCH'], `${P}/origins`, 'project:update'),
  rule(['POST'], `${P}/integrations`, 'project:update'),
  rule('delete', `${P}/integrations/[^/]+`, 'project:update'),
  rule('read', '^/upload-project-image-url/[^/]+', 'project:update'),
  rule('delete', '^/delete-project-image-url/[^/]+', 'project:update'),

  // Members.
  rule('read', `${P}/members`, 'members:read'),
  rule(['POST'], `${P}/members`, 'members:manage'),
  rule(['PATCH'], `${P}/members/[^/]+(/approve)?`, 'members:manage'),
  rule('delete', `${P}/members/[^/]+`, 'members:manage'),

  // Assets: the built-in storage, and a storage connection's files and folders.
  rule('read', `${P}/(storage|connections/storage/[^/]+)/(.+/)?(upload-url|replace-url)`, 'assets:write'),
  rule('read', `${P}/storage/.+`, 'assets:read'),
  rule(['PATCH'], `${P}/storage/files/[^/]+`, 'assets:write'),
  rule('delete', `${P}/storage/files/[^/]+`, 'assets:delete'),
  rule('read', `${P}/connections/storage/[^/]+/(files|folders)(/.+)?`, 'assets:read'),
  rule(['POST', 'PATCH'], `${P}/connections/storage/[^/]+/(files|folders)(/.+)?`, 'assets:write'),
  rule('delete', `${P}/connections/storage/[^/]+/(files|folders)/[^/]+`, 'assets:delete'),
  rule('read', `${P}/assets/[^/]+/(metadata|versions|qc-report|dependency-graph|download-url)`, 'assets:read'),
  rule(['PATCH'], `${P}/assets/[^/]+/metadata`, 'assets:write'),
  rule(['POST'], `${P}/assets/[^/]+/qc-report`, 'assets:write'),
  rule('read', `${P}/(reviews(/[^/]+)?|assets/[^/]+/versions/[^/]+/annotations)`, 'assets:read'),
  rule(['POST', 'PATCH'], `${P}/(reviews(/[^/]+/decision)?|assets/[^/]+/versions/[^/]+/annotations(/[^/]+/resolve)?)`, 'assets:write'),

  // Deliverables: an asset (or a version) delivered for a shot or an export.
  rule('read', `${P}/deliverables`, 'assets:read'),
  rule(['POST'], `${P}/deliverables`, 'assets:write'),
  rule('delete', `${P}/deliverables/[^/]+`, 'assets:write'),

  // Rights.
  rule('read', `${P}/assets/[^/]+/rights`, 'rights:read'),
  rule(['PUT'], `${P}/assets/[^/]+/rights`, 'rights:write'),
  rule('read', `${P}/credits-sheets(/[^/]+)?`, 'rights:read'),

  // Connections (API, database, storage, distribution, workers): the project's settings.
  rule('read', `${P}/dependents/[^/]+/[^/]+`, 'project:read'),
  rule('read', `${P}/(connections|get-connection|distribution-connections|workers)(/.+)?`, 'project:read'),
  rule('write', `${P}/(connections|distribution-connections|workers)(/.+)?`, 'project:update'),
  rule('delete', `${P}/(connections|distribution-connections|workers)/.+`, 'project:update'),

  // Production.
  rule('read', `${P}/production/.+`, 'production:read'),
  rule('write', `${P}/production/.+`, 'production:write'),
  rule('delete', `${P}/production/.+`, 'production:delete'),

  // Workflow and pipelines.
  rule('read', `${P}/(workflow|pipelines(/[^/]+)?)`, 'workflow:read'),
  rule(['PATCH'], `${P}/workflow`, 'workflow:write'),
  rule(['POST'], `${P}/pipelines`, 'workflow:write'),
  rule(['PATCH', 'DELETE'], `${P}/pipelines/[^/]+`, 'workflow:write'),

  // Exports.
  rule('read', `${P}/exports(/[^/]+)?`, 'exports:read'),
  rule(['POST'], `${P}/exports`, 'exports:write'),
  rule(['PATCH', 'DELETE'], `${P}/exports/[^/]+`, 'exports:write'),

  // Jobs: transcoding, rendering, AI, publishing a deliverable.
  rule('read', `${P}/jobs`, 'jobs:read'),
  rule(['POST'], `${P}/(jobs/[^/]+(/retry)?|pipeline-suggest|deliverables/[^/]+/publish)`, 'jobs:run'),

  // Documents: writing them is saving a version or moving them; publishing one (choosing what
  // the exports deliver, or whether they deliver it at all) is apart. A PATCH that changes
  // `exportable` needs docs:publish too (see routes/document).
  rule('read', `${P}/documents(/.+)?`, 'docs:read'),
  rule(['POST'], `${P}/documents/[^/]+/publish`, 'docs:publish'),
  rule('write', `${P}/documents(/[^/]+(/sections)?)?`, 'docs:write'),
  rule('delete', `${P}/documents/[^/]+`, 'docs:delete'),
];

/** The rule for a request made with an API token, or undefined: not reachable with one. */
export function routeRuleFor(method: string, path: string): RouteRule | undefined {
  const upper = method.toUpperCase();
  const found = RULES.find(r => r.methods.includes(upper) && r.pattern.test(path));
  return found && { permission: found.permission, userTokenOnly: found.userTokenOnly };
}

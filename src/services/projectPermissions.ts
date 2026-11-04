import { nosqlDb } from '../utils/nosqlDb';
import { projectRoleOf } from '../utils/auth';
import { OAUTH_SCOPE_PERMISSIONS } from './oauthTokens';
import { teamIdsOf, teamNotOf } from './teams';

// What a project lets each role do, and what it adds for the apps its members connect (OAuth,
// e.g. Claude). Its admins set it; until they do it's the rules StreamBy always had.
//
// Roles: an admin can do everything, a viewer only reads. What an editor can do is set action by
// action: each one is the editors' and the admins', or the admins' only. Managing members (who's
// in, and with which role) and deleting the project are always the admins': who manages members
// hands out roles. Managing teams is an action of its own, for roles: an API token manages them
// with members:manage.
//
// Teams: a team can add actions for its editors over what editors can do (an admins' only action,
// for the editors in it). A viewer in a team still only reads.
//
// Apps: an app gets a fixed set of permissions from its scopes (making and changing, never
// deleting nor publishing). A project can add some of the rest for the apps acting in it, never
// more than its user's role there lets them do.

/** What a role may be let do: the non-reading permissions, and managing teams. */
export const ROLE_ACTIONS = [
  'project:update',
  'teams:manage',
  'assets:write', 'assets:delete',
  'production:write', 'production:delete',
  'workflow:write',
  'exports:write',
  'rights:write',
  'jobs:run',
  'docs:write', 'docs:publish', 'docs:delete',
] as const;
export type RoleAction = typeof ROLE_ACTIONS[number];

/** Who may do an action: editors and admins, or admins only. */
export type ActionRole = 'editor' | 'admin';

/** What a project may add for its apps, over what their scopes grant. */
export const APP_PERMISSIONS = ['assets:delete', 'production:delete', 'docs:publish', 'docs:delete', 'members:manage'] as const;
export type AppPermission = typeof APP_PERMISSIONS[number];

export interface ProjectPermissions {
  roles: Record<RoleAction, ActionRole>;
  // What each team (by its id) adds for the editors in it.
  teams: Record<string, RoleAction[]>;
  apps: AppPermission[];
}

/** The rules as they've always been: editors do it all but manage teams; apps get nothing more. */
export const DEFAULT_PERMISSIONS: ProjectPermissions = {
  roles: Object.fromEntries(ROLE_ACTIONS.map(action => [action, action === 'teams:manage' ? 'admin' : 'editor'])) as Record<RoleAction, ActionRole>,
  teams: {},
  apps: [],
};

const isRoleAction = (value: unknown): value is RoleAction => (ROLE_ACTIONS as readonly unknown[]).includes(value);
const isAppPermission = (value: unknown): value is AppPermission => (APP_PERMISSIONS as readonly unknown[]).includes(value);

const configs = () => nosqlDb()?.collection<{ projectId: string; roles?: Partial<Record<RoleAction, ActionRole>>; teams?: Record<string, RoleAction[]>; apps?: AppPermission[]; updatedAt: Date }>('project_permissions') ?? null;

/** A project's permissions: what its admins set, the defaults for the rest. */
export async function readProjectPermissions(projectId: string): Promise<ProjectPermissions> {
  const saved = await configs()?.findOne({ projectId });
  const roles = { ...DEFAULT_PERMISSIONS.roles };
  for (const [action, role] of Object.entries(saved?.roles ?? {})) {
    if (isRoleAction(action) && (role === 'editor' || role === 'admin')) roles[action] = role;
  }
  const teams: Record<string, RoleAction[]> = {};
  for (const [teamId, actions] of Object.entries(saved?.teams ?? {})) {
    const valid = Array.isArray(actions) ? actions.filter(isRoleAction) : [];
    if (valid.length) teams[teamId] = valid;
  }
  return { roles, teams, apps: (saved?.apps ?? []).filter(isAppPermission) };
}

async function save(projectId: string, permissions: ProjectPermissions): Promise<void> {
  await configs()!.updateOne({ projectId }, { $set: { projectId, ...permissions, updatedAt: new Date() } }, { upsert: true });
}

/** A project's permissions changed: the roles, teams and apps given replace those it had (any may be left out). */
export async function setProjectPermissions(projectId: string, body: any): Promise<ProjectPermissions | { error: string; status?: number }> {
  const col = configs();
  if (!col) return { error: 'Database not available', status: 500 };
  const current = await readProjectPermissions(projectId);
  const next: ProjectPermissions = { roles: { ...current.roles }, teams: current.teams, apps: current.apps };
  if (body?.roles !== undefined) {
    if (!body.roles || typeof body.roles !== 'object' || Array.isArray(body.roles)) return { error: 'roles must map actions to editor or admin' };
    for (const [action, role] of Object.entries(body.roles)) {
      if (!isRoleAction(action)) return { error: `${action} isn't an action a role can be let do (${ROLE_ACTIONS.join(', ')})` };
      if (role !== 'editor' && role !== 'admin') return { error: `${action} must be editor (editors and admins) or admin (admins only)` };
      next.roles[action] = role;
    }
  }
  if (body?.teams !== undefined) {
    if (!body.teams || typeof body.teams !== 'object' || Array.isArray(body.teams)) return { error: 'teams must map team ids to lists of actions' };
    const teams: Record<string, RoleAction[]> = {};
    for (const [teamId, actions] of Object.entries(body.teams)) {
      if (!Array.isArray(actions) || !actions.every(isRoleAction)) return { error: `A team's actions must be a list of: ${ROLE_ACTIONS.join(', ')}` };
      if (actions.length) teams[teamId] = [...new Set(actions as RoleAction[])];
    }
    if (await teamNotOf(projectId, Object.keys(teams))) return { error: 'teams must be teams of the project' };
    next.teams = teams;
  }
  if (body?.apps !== undefined) {
    if (!Array.isArray(body.apps) || !body.apps.every(isAppPermission)) return { error: `apps must be a list of: ${APP_PERMISSIONS.join(', ')}` };
    next.apps = [...new Set(body.apps as AppPermission[])];
  }
  await save(projectId, next);
  return next;
}

type Project = Parameters<typeof projectRoleOf>[0];

/** Whether someone's role in a project (and, for an editor, the teams they're in) lets them do an action there (an admin always). */
export function roleAllows(permissions: ProjectPermissions, role: string | undefined, action: RoleAction, teamIds: string[] = []): boolean {
  if (role === 'admin') return true;
  if (role !== 'editor') return false;
  return permissions.roles[action] === 'editor' || teamIds.some(id => permissions.teams[id]?.includes(action));
}

/** Whether a member of a project may do an action there: by their role, their teams and the project's permissions. */
export async function memberMay(projectId: string, role: string | undefined, userId: string | undefined, action: RoleAction): Promise<boolean> {
  if (role === 'admin') return true;
  if (role !== 'editor') return false;
  const permissions = await readProjectPermissions(projectId);
  if (roleAllows(permissions, role, action)) return true;
  // Only asked when it may make the difference.
  return Object.keys(permissions.teams).length > 0 && roleAllows(permissions, role, action, await teamIdsOf(projectId, userId));
}

/** Whether a member of a project may do an action there, by their role, their teams and the project's permissions. */
export async function roleMay(project: Project, userId: string | undefined, action: RoleAction): Promise<boolean> {
  return memberMay(String(project?._id ?? project?.id ?? ''), projectRoleOf(project, userId), userId, action);
}

/** A deleted team adds nothing any more. */
export async function forgetTeamPermissions(projectId: string, teamId: string): Promise<void> {
  const current = await readProjectPermissions(projectId);
  if (!current.teams[teamId] || !configs()) return;
  const { [teamId]: _gone, ...teams } = current.teams;
  await save(projectId, { ...current, teams });
}

/** What the apps connected to a project get there over their scopes. */
export async function appPermissionsOf(projectId: string): Promise<AppPermission[]> {
  return (await readProjectPermissions(projectId)).apps;
}

/** Whether an app was approved to write (streamby:write): only then may a project add to what it does. */
export const isWritingApp = (permissions: readonly string[] | undefined): boolean =>
  OAUTH_SCOPE_PERMISSIONS['streamby:write'].every(p => !!permissions?.includes(p));

/** What a request's app gets in a project over its scopes: nothing if it isn't an app approved to write. */
export async function appAddsFor(auth: { oauth?: unknown; apiToken?: { permissions: readonly string[] } } | undefined, projectId: string | undefined): Promise<AppPermission[]> {
  if (!auth?.oauth || !projectId || !isWritingApp(auth.apiToken?.permissions)) return [];
  return appPermissionsOf(projectId);
}

/** A deleted project's permissions. */
export async function deletePermissionsOf(projectId: string): Promise<void> {
  if (projectId) await configs()?.deleteMany({ projectId });
}

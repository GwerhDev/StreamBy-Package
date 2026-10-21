import { ProjectInfo } from '../types';

type ProjectMembers = (Pick<ProjectInfo, 'members'> & { _id?: unknown; id?: unknown }) | null | undefined;

// A project's API token acts on its project as itself, not as a user: its request's userId is
// this principal, naming the token and its project. In that project it's an admin -- what it
// may do is only its permissions (see enforceApiTokenScope) -- and in any other, nobody.
const PROJECT_TOKEN_PRINCIPAL = 'project-token:';

export const projectTokenPrincipal = (tokenId: string, projectId: string) => `${PROJECT_TOKEN_PRINCIPAL}${tokenId}:${projectId}`;

export const isProjectTokenPrincipal = (userId: unknown): boolean =>
  typeof userId === 'string' && userId.startsWith(PROJECT_TOKEN_PRINCIPAL);

const projectOfPrincipal = (userId: string): string | undefined => {
  if (!isProjectTokenPrincipal(userId)) return undefined;
  const rest = userId.slice(PROJECT_TOKEN_PRINCIPAL.length);
  return rest.slice(rest.indexOf(':') + 1) || undefined;
};

// A project's member who's in it now: invited and accepted (status 'active'). (A member's
// `archived` is only that member having archived the project in their own list.)
export function activeMemberOf(project: ProjectMembers, userId: string | undefined) {
  if (!project || !userId) return undefined;
  const tokenProject = projectOfPrincipal(userId);
  if (tokenProject !== undefined) {
    const id = String(project._id ?? project.id ?? '');
    return id && id === tokenProject ? { userId, username: 'API token', role: 'admin' as const, status: 'active' as const, archived: false } : undefined;
  }
  if (!project.members) return undefined;
  return project.members.find(member => member.userId?.toString() === userId && member.status === 'active');
}

// What a user can do in a project is their role in it, as an active member -- never their
// role on the platform (Auth.role): a pending invitation is no access yet.
export const projectRoleOf = (project: ProjectMembers, userId: string | undefined) => activeMemberOf(project, userId)?.role;

/** An active member, whatever their role: can see the project. */
export const isProjectMember = (project: ProjectMembers, userId: string | undefined): boolean => !!projectRoleOf(project, userId);

/** An editor or an admin of the project: can change it (its content, its connections). */
export const canEditProject = (project: ProjectMembers, userId: string | undefined): boolean =>
  ['editor', 'admin'].includes(projectRoleOf(project, userId) ?? '');

/** An admin of the project: can manage its members, and delete it. */
export const isProjectAdmin = (project: ProjectMembers, userId: string | undefined): boolean =>
  projectRoleOf(project, userId) === 'admin';


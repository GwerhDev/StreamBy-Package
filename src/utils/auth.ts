import { ProjectInfo, Auth } from '../types';

type ProjectMembers = Pick<ProjectInfo, 'members'> | null | undefined;

// A project's member who's in it now: invited and accepted (status 'active'). (A member's
// `archived` is only that member having archived the project in their own list.)
export function activeMemberOf(project: ProjectMembers, userId: string | undefined) {
  if (!project?.members || !userId) return undefined;
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


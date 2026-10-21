import { ProjectInfo, Auth } from '../types';

// A project's member who's in it now: invited and accepted (status 'active'), not archived.
export function activeMemberOf(project: Pick<ProjectInfo, 'members'> | null | undefined, userId: string | undefined) {
  if (!project?.members || !userId) return undefined;
  return project.members.find(member =>
    member.userId?.toString() === userId && member.status === 'active' && !member.archived);
}

export function isProjectMember(project: ProjectInfo, userId: string): boolean {
  if (!project || !project.members) {
    return false;
  }
  return project.members.some(member => member.userId === userId);
}


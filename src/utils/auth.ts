import { ProjectInfo, Auth } from '../types';

export function isProjectMember(project: ProjectInfo, userId: string): boolean {
  if (!project || !project.members) {
    return false;
  }
  return project.members.some(member => member.userId === userId);
}


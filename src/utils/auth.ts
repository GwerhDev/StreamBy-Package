export function isProjectMember(project: any, userId: string) {
  return project.members?.some((m: any) => m.userId?.toString() === userId?.toString());
}

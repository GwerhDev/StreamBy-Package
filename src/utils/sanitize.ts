export function sanitizeProject(project: any): any {
  if (!project) return project;
  return {
    ...project,
    credentials: project.credentials?.map(({ id, key }: any) => ({ id, key })) ?? [],
  };
}

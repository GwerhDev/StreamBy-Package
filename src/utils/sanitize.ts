export function sanitizeProject(project: any): any {
  if (!project) return project;
  return {
    ...project,
    credentials: project.credentials?.map(({ id, key }: any) => ({ id, key })) ?? [],
  };
}

export function sanitizeUserIntegration(integration: any): any {
  if (!integration) return integration;
  const { encryptedCredential, ...rest } = integration;
  return rest;
}

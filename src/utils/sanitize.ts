export function sanitizeConnection<T extends { encryptedCredential?: string }>(
  conn: T
): Omit<T, 'encryptedCredential'> & { hasCredential: boolean } {
  const { encryptedCredential, ...rest } = conn;
  return { ...rest, hasCredential: !!encryptedCredential };
}

export function sanitizeConnections<T extends { encryptedCredential?: string }>(
  conns: T[] | undefined
): (Omit<T, 'encryptedCredential'> & { hasCredential: boolean })[] {
  return (conns ?? []).map(sanitizeConnection);
}

export function sanitizeProject(project: any): any {
  if (!project) return project;
  return {
    ...project,
    credentials: undefined,
    connections: sanitizeConnections(project.connections),
    storageConnections: sanitizeConnections(project.storageConnections),
    dbConnections: sanitizeConnections(project.dbConnections),
    distributionConnections: sanitizeConnections(project.distributionConnections),
    renderFarmConnections: sanitizeConnections(project.renderFarmConnections),
    exports: project.exports?.map((e: any) =>
      e && 'encryptedCredential' in e ? sanitizeConnection(e) : e
    ),
  };
}

export function sanitizeUserIntegration(integration: any): any {
  if (!integration) return integration;
  const { encryptedCredential, ...rest } = integration;
  return rest;
}

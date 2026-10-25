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

// IntegrationConnection has no encryptedCredential field at all — credentials never live on
// the connection, only integrationId does, resolved on-demand from the account-level
// UserIntegration. hasCredential is hardcoded true (never derived from a local field) for
// API shape parity with the other three connection types.
export function sanitizeIntegrationConnection<T extends object>(conn: T): T & { hasCredential: true } {
  return { ...conn, hasCredential: true };
}

export function sanitizeIntegrationConnections<T extends object>(conns: T[] | undefined): (T & { hasCredential: true })[] {
  return (conns ?? []).map(sanitizeIntegrationConnection);
}

// A project's exports as they're listed: what each one is, not its schema nor its credentials.
// The same in the project (GET /projects/:id) and in its own list (GET /projects/:id/exports).
export function exportSummaries(exports: any[] | undefined): any[] {
  return (exports || []).map((e: any) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    method: e.method,
    private: e.private,
    useConnections: e.useConnections,
    useCredentials: e.useCredentials,
  }));
}

export function sanitizeProject(project: any): any {
  if (!project) return project;
  return {
    ...project,
    credentials: undefined,
    connections: sanitizeConnections(project.connections),
    storageConnections: sanitizeConnections(project.storageConnections),
    dbConnections: sanitizeConnections(project.dbConnections),
    integrationConnections: sanitizeIntegrationConnections(project.integrationConnections),
    distributionConnections: sanitizeConnections(project.distributionConnections),
    renderFarmConnections: sanitizeConnections(project.renderFarmConnections),
    exports: project.exports?.map((e: any) =>
      e && 'encryptedCredential' in e ? sanitizeConnection(e) : e
    ),
  };
}

// Strips every raw secret an OAuth-backed integration might carry — encryptedCredential
// (db/storage/claude) plus encryptedAccessToken/encryptedRefreshToken (jira/google).
// tokenExpiresAt is deliberately kept: it's not secret, and its presence lets a future UI
// show "reconnect needed" without a decrypt round-trip.
export function sanitizeUserIntegration(integration: any): any {
  if (!integration) return integration;
  const { encryptedCredential, encryptedAccessToken, encryptedRefreshToken, ...rest } = integration;
  return rest;
}

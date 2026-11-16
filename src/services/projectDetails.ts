// A project's details: what its settings form (and an agent, update_project) changes. Only
// these are written by PATCH /projects/:id; its members, connections, exports and the rest
// have routes of their own, with their own checks.

export const PROJECT_DETAILS = ['name', 'description', 'image', 'allowedOrigin', 'public', 'category'] as const;
export type ProjectDetail = typeof PROJECT_DETAILS[number];
export type ProjectDetails = Partial<Record<ProjectDetail, unknown>>;

const isDetail = (key: string): key is ProjectDetail => (PROJECT_DETAILS as readonly string[]).includes(key);

/**
 * The details a request changes, each checked, or what's wrong with them (nothing is saved
 * then). `baseUpdatedAt`, when given, is the project's updatedAt as it was read: an ISO date,
 * or null for a project never saved since it had one.
 */
export function parseProjectDetails(body: unknown): { changes: ProjectDetails; baseUpdatedAt?: string | null } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Missing updates payload' };
  const { baseUpdatedAt, ...fields } = body as Record<string, unknown>;

  const unknown = Object.keys(fields).filter(key => !isDetail(key));
  if (unknown.length) return { error: `Only a project's details are changed here (${PROJECT_DETAILS.join(', ')}), not ${unknown.join(', ')}` };
  if (!Object.keys(fields).length) return { error: 'Nothing to change' };

  const { name, description, image, allowedOrigin, public: isPublic, category } = fields;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return { error: 'name must be a non-empty text' };
  if (description !== undefined && typeof description !== 'string') return { error: 'description must be a text' };
  if (image !== undefined && typeof image !== 'string') return { error: 'image must be a text' };
  if (allowedOrigin !== undefined && (!Array.isArray(allowedOrigin) || !allowedOrigin.every(o => typeof o === 'string'))) {
    return { error: 'allowedOrigin must be a list of origins' };
  }
  if (isPublic !== undefined && typeof isPublic !== 'boolean') return { error: 'public must be true or false' };
  if (category !== undefined && category !== null && typeof category !== 'string') return { error: 'category must be a text, or null' };

  if (baseUpdatedAt !== undefined && baseUpdatedAt !== null
    && (typeof baseUpdatedAt !== 'string' || Number.isNaN(Date.parse(baseUpdatedAt)))) {
    return { error: 'baseUpdatedAt must be the project\'s updatedAt as it was read (an ISO date), or null' };
  }

  const changes: ProjectDetails = { ...fields };
  if (typeof name === 'string') changes.name = name.trim();
  return { changes, ...(baseUpdatedAt !== undefined ? { baseUpdatedAt: baseUpdatedAt as string | null } : {}) };
}

/** When the project was last saved: an ISO date, or null if it never was since it had one. */
export const updatedAtOf = (project: any): string | null => {
  const value = project?.updatedAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Whether the project was saved since it was read at `base`. */
export const savedSince = (project: any, base: string | null): boolean =>
  updatedAtOf(project) !== (base === null ? null : new Date(base).toISOString());

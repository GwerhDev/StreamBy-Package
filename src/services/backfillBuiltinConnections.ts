import crypto from 'crypto';
import { getModel } from '../models/manager';
import { DbConnection, ProjectInfo, StorageConnection, StreamByConfig } from '../types';
import { BUILTIN_DB_DISPLAY, BUILTIN_STORAGE_DISPLAY } from '../utils/builtinAccess';

// Pre-BYOC, every project appeared connected to every configured builtin because
// storageConnection.ts/dbConnection.ts SYNTHESIZED builtins at read time instead of
// persisting them (see storageConnection.ts's old GET handler). Now that connections must
// be real rows on the project, this seeds those rows once for projects that predate the
// change — so existing projects don't silently lose access on deploy.
//
// Guarded by ProjectInfo.builtinBackfilledAt: runs once per project, ever. An admin who
// later disconnects a builtin on purpose won't have it silently reappear on the next boot.
export async function backfillBuiltinConnections(config: StreamByConfig): Promise<void> {
  if (!config.databases?.length && !config.storageProviders?.length) return;

  const Project = getModel('projects');
  const allProjects = await Project.find({}) as ProjectInfo[];
  const pending = allProjects.filter(p => !p.builtinBackfilledAt);
  if (!pending.length) return;

  for (const project of pending) {
    const now = new Date();

    const dbConnections: DbConnection[] = (config.databases ?? []).map(db => ({
      id: crypto.randomUUID(),
      name: BUILTIN_DB_DISPLAY[db.type] ?? db.type,
      dbType: db.type === 'sql' ? 'postgresql' : 'mongodb',
      credentialId: '',
      projectId: project.id,
      createdAt: now,
      isBuiltin: true,
      integrationId: db.id,
      source: 'builtin',
    }));

    const storageConnections: StorageConnection[] = (config.storageProviders ?? []).map(provider => ({
      id: crypto.randomUUID(),
      name: BUILTIN_STORAGE_DISPLAY[provider.type] ?? provider.type,
      type: provider.type,
      credentialId: '',
      projectId: project.id,
      createdAt: now,
      isBuiltin: true,
      integrationId: provider.id,
      source: 'builtin',
    }));

    await Project.update({ _id: project.id }, {
      dbConnections: [...(project.dbConnections ?? []), ...dbConnections],
      storageConnections: [...(project.storageConnections ?? []), ...storageConnections],
      builtinBackfilledAt: now,
    } as Partial<ProjectInfo>);
  }

  console.log(`✅ Backfilled built-in connections for ${pending.length} project(s).`);
}

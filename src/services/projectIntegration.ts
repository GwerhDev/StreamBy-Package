import crypto from 'crypto';
import { getModel } from '../models/manager';
import { Auth, DbConnection, StorageConnection, StreamByConfig } from '../types';
import { assertBuiltinAccess, isBuiltinDb, isBuiltinStorageId, BUILTIN_DB_DISPLAY, BUILTIN_STORAGE_DISPLAY } from '../utils/builtinAccess';

type ClassifyResult =
  | { kind: 'database'; connection: DbConnection }
  | { kind: 'storage'; connection: StorageConnection }
  | { error: string; status: number };

// Classifies a client-supplied integrationId (builtin db, builtin storage, or a user's own
// BYOC integration) and revalidates access/ownership server-side — never trust the client.
// Shared by POST /projects/create (bulk, at project creation) and
// POST /projects/:id/integrations (single, added to an existing project).
export async function classifyIntegrationId(
  id: string,
  auth: Auth,
  config: StreamByConfig,
  projectId: string,
): Promise<ClassifyResult> {
  const now = new Date();

  if (isBuiltinDb(id, config)) {
    if (!(await assertBuiltinAccess(auth, id, config, 'database'))) {
      return { error: `Access to built-in database '${id}' is not permitted`, status: 403 };
    }
    const db = config.databases!.find(d => d.id === id)!;
    return {
      kind: 'database',
      connection: {
        id: crypto.randomUUID(), name: BUILTIN_DB_DISPLAY[db.type] ?? db.type, dbType: db.type === 'sql' ? 'postgresql' : 'mongodb',
        credentialId: '', projectId, createdAt: now, isBuiltin: true, integrationId: id, source: 'builtin',
      },
    };
  }

  if (isBuiltinStorageId(id, config)) {
    if (!(await assertBuiltinAccess(auth, id, config, 'storage'))) {
      return { error: `Access to built-in storage '${id}' is not permitted`, status: 403 };
    }
    const provider = config.storageProviders.find(p => p.id === id)!;
    return {
      kind: 'storage',
      connection: {
        id: crypto.randomUUID(), name: BUILTIN_STORAGE_DISPLAY[provider.type] ?? provider.type, type: provider.type,
        credentialId: '', projectId, createdAt: now, isBuiltin: true, integrationId: id, source: 'builtin',
      },
    };
  }

  const UserIntegrationModel = getModel('user_integrations');
  const integration = await UserIntegrationModel.findOne({ id, userId: auth.userId });
  if (!integration) {
    return { error: `Integration '${id}' is not valid or does not belong to you`, status: 403 };
  }

  if (integration.kind === 'database') {
    return {
      kind: 'database',
      connection: {
        id: crypto.randomUUID(), name: integration.name, dbType: integration.provider,
        credentialId: '', projectId, createdAt: now, isBuiltin: false, integrationId: id, source: 'integration',
      },
    };
  }
  return {
    kind: 'storage',
    connection: {
      id: crypto.randomUUID(), name: integration.name, type: integration.provider,
      credentialId: '', projectId, createdAt: now, isBuiltin: false, integrationId: id, source: 'integration',
    },
  };
}

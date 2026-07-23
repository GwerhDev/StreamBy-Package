import { Auth, StreamByConfig } from '../types';

// Gates access to a built-in database/storage provider. Delegates to config.canUseBuiltin
// when the mounting app implements it (e.g. Nhexa-API checking user_subscriptions);
// defaults to allow when absent, preserving pre-BYOC behavior for deploys without gating.
export async function assertBuiltinAccess(
  auth: Auth,
  builtinId: string,
  config: StreamByConfig,
  kind: 'database' | 'storage',
): Promise<boolean> {
  if (!config.canUseBuiltin) return true;
  return config.canUseBuiltin(auth, builtinId, kind);
}

export function isBuiltinStorageId(id: string, config: StreamByConfig): boolean {
  return (config.storageProviders ?? []).some(p => p.id === id);
}

export function isBuiltinDb(id: string, config: StreamByConfig): boolean {
  return (config.databases ?? []).some(db => db.id === id);
}

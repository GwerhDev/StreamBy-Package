import { getModel } from '../models/manager';
import { decrypt, encrypt, isCurrentEncryption, isEncryptionKeySet, isVersionedEncryption } from '../utils/encryption';

// Brings every stored credential to the current encryption (AES-256-GCM with the current key,
// see utils/encryption): those encrypted before (CBC, or GCM with a previous key) are
// re-encrypted, and the distribution and render farm credentials, stored as they were sent,
// are encrypted. Non-destructive: a value is replaced only by its own re-encryption; one that
// can't be decrypted is left as it is (and counted). Runs at startup; once everything is
// current, it changes nothing.

// A project's lists of connections with a credential each, encrypted before.
const ENCRYPTED_LISTS = ['connections', 'dbConnections', 'storageConnections', 'exports'] as const;
// The ones whose credentials were stored as sent, never encrypted.
const PLAIN_LISTS = ['distributionConnections', 'renderFarmConnections'] as const;
const INTEGRATION_FIELDS = ['encryptedCredential', 'encryptedAccessToken', 'encryptedRefreshToken'] as const;

export interface ReencryptResult {
  updated: number;
  failed: number;
}

export async function reencryptStoredCredentials(): Promise<ReencryptResult> {
  const result: ReencryptResult = { updated: 0, failed: 0 };
  if (!isEncryptionKeySet()) return result;

  // The current encryption of a stored value, or undefined when it's current already or
  // can't be read (left as it is).
  const upgrade = (value: unknown, storedPlain: boolean): string | undefined => {
    if (typeof value !== 'string' || !value || isCurrentEncryption(value)) return undefined;
    if (storedPlain && !isVersionedEncryption(value)) return encrypt(value);
    try {
      return encrypt(decrypt(value));
    } catch {
      result.failed++;
      return undefined;
    }
  };

  const Project = getModel('projects');
  for (const project of (await Project.find({})) as any[]) {
    const changes: Record<string, unknown[]> = {};
    for (const list of [...ENCRYPTED_LISTS, ...PLAIN_LISTS]) {
      const entries = project[list];
      if (!Array.isArray(entries)) continue;
      const storedPlain = (PLAIN_LISTS as readonly string[]).includes(list);
      let changed = false;
      const next = entries.map((entry: any) => {
        const upgraded = upgrade(entry?.encryptedCredential, storedPlain);
        if (upgraded === undefined) return entry;
        changed = true;
        return { ...entry, encryptedCredential: upgraded };
      });
      if (changed) changes[list] = next;
    }
    if (Object.keys(changes).length) {
      await Project.update({ _id: project._id ?? project.id }, changes);
      result.updated++;
    }
  }

  const UserIntegration = getModel('user_integrations');
  for (const integration of (await UserIntegration.find({})) as any[]) {
    const changes: Record<string, string> = {};
    for (const field of INTEGRATION_FIELDS) {
      const upgraded = upgrade(integration[field], false);
      if (upgraded !== undefined) changes[field] = upgraded;
    }
    if (Object.keys(changes).length) {
      await UserIntegration.update({ id: integration.id }, changes);
      result.updated++;
    }
  }

  return result;
}

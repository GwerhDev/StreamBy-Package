import crypto from 'crypto';
import { getModel } from '../models/manager';
import { IntegrationKind, UserIntegration } from '../types';
import { encrypt, decrypt, isEncryptionKeySet } from '../utils/encryption';

function encryptCredential(kind: IntegrationKind, value: unknown): string {
  return kind === 'storage' ? encrypt(JSON.stringify(value)) : encrypt(String(value));
}

export async function listUserIntegrations(userId: string): Promise<UserIntegration[]> {
  const UserIntegrationModel = getModel('user_integrations');
  return UserIntegrationModel.find({ userId });
}

export async function createUserIntegration(
  userId: string,
  input: { kind: IntegrationKind; provider: string; name: string; description?: string; credentialValue: unknown },
): Promise<UserIntegration> {
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot create integration.');
  }

  const UserIntegrationModel = getModel('user_integrations');
  const now = new Date();
  const integration: UserIntegration = {
    id: crypto.randomUUID(),
    userId,
    kind: input.kind,
    provider: input.provider as UserIntegration['provider'],
    name: input.name,
    description: input.description,
    encryptedCredential: encryptCredential(input.kind, input.credentialValue),
    createdAt: now,
    updatedAt: now,
  };

  return UserIntegrationModel.create(integration);
}

export async function updateUserIntegration(
  userId: string,
  integrationId: string,
  updates: { name?: string; description?: string; credentialValue?: unknown },
): Promise<UserIntegration | null> {
  const UserIntegrationModel = getModel('user_integrations');
  const existing = await UserIntegrationModel.findOne({ id: integrationId, userId }) as UserIntegration | null;
  if (!existing) return null;

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) $set.name = updates.name;
  if (updates.description !== undefined) $set.description = updates.description;
  if (updates.credentialValue !== undefined) {
    if (!isEncryptionKeySet()) {
      throw new Error('Encryption key is not set. Cannot update integration.');
    }
    $set.encryptedCredential = encryptCredential(existing.kind, updates.credentialValue);
  }

  return UserIntegrationModel.update({ id: integrationId, userId }, $set);
}

export async function deleteUserIntegration(userId: string, integrationId: string): Promise<boolean> {
  const UserIntegrationModel = getModel('user_integrations');
  const deletedCount = await UserIntegrationModel.delete({ id: integrationId, userId });
  return deletedCount > 0;
}

export async function getDecryptedIntegrationCredential(userId: string, integrationId: string): Promise<unknown | null> {
  const UserIntegrationModel = getModel('user_integrations');
  const integration = await UserIntegrationModel.findOne({ id: integrationId, userId }) as UserIntegration | null;
  if (!integration) return null;
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot decrypt integration credential.');
  }
  const decrypted = decrypt(integration.encryptedCredential);
  return integration.kind === 'storage' ? JSON.parse(decrypted) : decrypted;
}

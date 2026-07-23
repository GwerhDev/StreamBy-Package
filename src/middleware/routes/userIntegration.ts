import { Router, Request, Response } from 'express';
import { Auth, ExternalDbType, IntegrationKind, StorageProviderType, StreamByConfig } from '../../types';
import { assertBuiltinAccess } from '../../utils/builtinAccess';
import {
  createUserIntegration,
  deleteUserIntegration,
  listUserIntegrations,
  updateUserIntegration,
} from '../../services/userIntegration';
import { sanitizeUserIntegration } from '../../utils/sanitize';

const VALID_KINDS: IntegrationKind[] = ['database', 'storage'];
const VALID_DB_PROVIDERS: ExternalDbType[] = ['postgresql', 'mongodb'];
const VALID_STORAGE_PROVIDERS: StorageProviderType[] = ['s3', 'gcs', 'r2', 'azure'];

interface PoolEntry {
  id: string;
  kind: IntegrationKind;
  name: string;
  provider: string;
  source: 'builtin' | 'integration';
  available: boolean;
  requiredPlan?: string;
}

export function userIntegrationRouter(config: StreamByConfig): Router {
  const router = Router();

  // ─── Combined pool: account integrations + built-ins the user can access ─────
  router.get('/user/integrations', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      const owned = await listUserIntegrations(auth.userId);
      const pool: PoolEntry[] = owned.map(i => ({
        id: i.id, kind: i.kind, name: i.name, provider: i.provider, source: 'integration', available: true,
      }));

      for (const db of config.databases ?? []) {
        // requiredPlan is not populated here — canUseBuiltin only returns a boolean today,
        // so there's no plan-level detail to surface without a hook-signature change.
        const available = await assertBuiltinAccess(auth, db.id, config, 'database');
        pool.push({ id: db.id, kind: 'database', name: db.id, provider: db.type, source: 'builtin', available });
      }

      for (const provider of config.storageProviders ?? []) {
        const available = await assertBuiltinAccess(auth, provider.id, config, 'storage');
        pool.push({ id: provider.id, kind: 'storage', name: provider.id, provider: provider.type, source: 'builtin', available });
      }

      res.json({ data: pool });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to list integrations', details: err.message });
    }
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  router.post('/user/integrations', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { kind, provider, name, description, credential } = req.body;

      if (!kind || !VALID_KINDS.includes(kind)) {
        return res.status(400).json({ message: `kind must be one of: ${VALID_KINDS.join(', ')}` });
      }
      const validProviders: string[] = kind === 'database' ? VALID_DB_PROVIDERS : VALID_STORAGE_PROVIDERS;
      if (!provider || !validProviders.includes(provider)) {
        return res.status(400).json({ message: `provider must be one of: ${validProviders.join(', ')}` });
      }
      if (!name) return res.status(400).json({ message: 'name is required' });
      if (credential === undefined || credential === null) {
        return res.status(400).json({ message: 'credential is required' });
      }

      const integration = await createUserIntegration(auth.userId, {
        kind, provider, name, description, credentialValue: credential,
      });
      res.status(201).json({ data: sanitizeUserIntegration(integration) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create integration', details: err.message });
    }
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  router.patch('/user/integrations/:integrationId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { name, description, credential } = req.body;

      const updated = await updateUserIntegration(auth.userId, req.params.integrationId, {
        name, description, credentialValue: credential,
      });
      if (!updated) return res.status(404).json({ message: 'Integration not found' });

      res.json({ data: sanitizeUserIntegration(updated) });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update integration', details: err.message });
    }
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  router.delete('/user/integrations/:integrationId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const deleted = await deleteUserIntegration(auth.userId, req.params.integrationId);
      if (!deleted) return res.status(404).json({ message: 'Integration not found' });

      res.json({ message: 'Integration deleted' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete integration', details: err.message });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Auth, ServiceProviderType, StreamByConfig } from '../../types';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../../services/oauthClient';
import { upsertOAuthServiceIntegration } from '../../services/userIntegration';

const OAUTH_PROVIDERS = new Set<string>(['jira', 'google']);
type OAuthProvider = Extract<ServiceProviderType, 'jira' | 'google'>;

const PROVIDER_DISPLAY_NAME: Record<OAuthProvider, string> = {
  jira: 'Jira',
  google: 'Google',
};

interface PendingState {
  userId: string;
  provider: OAuthProvider;
  issuedAt: number;
}

// In-memory, single-process state store — the OAuth dance completes within a few minutes
// of the same request cycle, so no DB collection is needed. A restart mid-flow just means
// the user retries /start, which is harmless.
const pendingOAuthStates = new Map<string, PendingState>();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepExpiredStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pendingOAuthStates) {
    if (entry.issuedAt < cutoff) pendingOAuthStates.delete(state);
  }
}

function isOAuthProvider(value: string): value is OAuthProvider {
  return OAUTH_PROVIDERS.has(value);
}

export function oauthRouter(config: StreamByConfig): Router {
  const router = Router();

  router.get('/user/integrations/oauth/:provider/start', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { provider } = req.params;

      if (!isOAuthProvider(provider)) {
        return res.status(400).json({ message: `Provider '${provider}' does not support OAuth.` });
      }

      const oauthConfig = config.oauthProviders?.[provider];
      if (!oauthConfig) {
        return res.status(503).json({ message: `OAuth for '${provider}' is not configured on this deployment.` });
      }

      sweepExpiredStates();
      const state = crypto.randomBytes(32).toString('hex');
      pendingOAuthStates.set(state, { userId: auth.userId, provider, issuedAt: Date.now() });

      res.redirect(buildAuthorizeUrl(provider, oauthConfig, state));
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to start OAuth flow', details: err.message });
    }
  });

  router.get('/user/integrations/oauth/:provider/callback', async (req: Request, res: Response) => {
    const { provider: providerParam } = req.params;
    const provider = isOAuthProvider(providerParam) ? providerParam : null;
    const oauthConfig = provider ? config.oauthProviders?.[provider] : undefined;

    const failureRedirect = (reason: string) => {
      const failureUrl = oauthConfig?.failureRedirectUrl;
      if (!failureUrl) return res.status(400).json({ message: `OAuth failed: ${reason}` });
      const url = new URL(failureUrl);
      url.searchParams.set('oauthError', reason);
      if (provider) url.searchParams.set('provider', provider);
      return res.redirect(url.toString());
    };

    try {
      const auth = (req as any).auth as Auth;

      if (!provider) return res.status(400).json({ message: `Provider '${providerParam}' does not support OAuth.` });
      if (!oauthConfig) return res.status(503).json({ message: `OAuth for '${provider}' is not configured on this deployment.` });

      if (req.query.error) return failureRedirect(String(req.query.error));
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      if (!code || !state) return failureRedirect('missing_code');

      const pending = pendingOAuthStates.get(state);
      pendingOAuthStates.delete(state); // single-use, regardless of outcome below
      if (!pending || pending.provider !== provider || pending.userId !== auth.userId) {
        return failureRedirect(pending ? 'state_mismatch' : 'invalid_state');
      }

      let tokens;
      try {
        tokens = await exchangeCodeForTokens(provider, oauthConfig, code);
      } catch {
        return failureRedirect('token_exchange_failed');
      }

      await upsertOAuthServiceIntegration(auth.userId, provider, PROVIDER_DISPLAY_NAME[provider], tokens);

      const url = new URL(oauthConfig.successRedirectUrl);
      url.searchParams.set('connected', provider);
      res.redirect(url.toString());
    } catch (err: any) {
      failureRedirect('unexpected_error');
    }
  });

  return router;
}

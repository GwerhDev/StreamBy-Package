import { OAuthClientConfig, ServiceProviderType } from '../types';

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// TODO: adjust once a real Google OAuth app is registered — see TCORE-73 plan §4.
const GOOGLE_OAUTH_SCOPES = 'openid email profile';
// MUST include offline_access to receive a refresh token from Atlassian.
const JIRA_OAUTH_SCOPES = 'offline_access read:jira-user read:jira-work';

export function buildAuthorizeUrl(provider: 'jira' | 'google', config: OAuthClientConfig, state: string): string {
  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: GOOGLE_OAUTH_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: config.clientId,
    scope: JIRA_OAUTH_SCOPES,
    redirect_uri: config.redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `https://auth.atlassian.com/authorize?${params.toString()}`;
}

async function parseTokenResponse(response: Response): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Token endpoint returned ${response.status}: ${body}`);
  }
  return response.json();
}

export async function exchangeCodeForTokens(provider: 'jira' | 'google', config: OAuthClientConfig, code: string): Promise<ExchangedTokens> {
  if (provider === 'google') {
    const body = new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await parseTokenResponse(response);
    if (!json.refresh_token) throw new Error('Google did not return a refresh_token — retry with access_type=offline&prompt=consent');
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  const response = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const json = await parseTokenResponse(response);
  if (!json.refresh_token) throw new Error('Atlassian did not return a refresh_token — ensure the offline_access scope is requested');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

// Google's refresh response usually omits refresh_token (the original stays valid);
// Atlassian ROTATES the refresh token on every use (a new one is returned every time).
// Callers must preserve the existing refreshToken when this returns undefined for it.
export async function refreshTokens(provider: 'jira' | 'google', config: OAuthClientConfig, refreshToken: string): Promise<ExchangedTokens> {
  if (provider === 'google') {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await parseTokenResponse(response);
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  const response = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const json = await parseTokenResponse(response);
  if (!json.refresh_token) throw new Error('Atlassian refresh response did not include a rotated refresh_token');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

// Claude uses a dedicated x-api-key header (plus anthropic-version), not Authorization:
// Bearer — Jira/Google's OAuth access tokens use the standard Bearer scheme.
export function buildServiceAuthHeaders(provider: ServiceProviderType, credential: string): Record<string, string> {
  if (provider === 'claude') {
    return { 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${credential}` };
}

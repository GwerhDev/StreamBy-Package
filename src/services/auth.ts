import { Request } from 'express';
import { StreamByConfig, AuthContext } from '../types';

export async function resolveAuth(config: StreamByConfig, req: Request): Promise<AuthContext> {
  const auth = await config.authProvider(req);

  if (
    !auth ||
    !auth.userId ||
    !auth.role
  ) {
    throw new Error('Invalid or missing authentication context');
  }

  return auth;
}

export function checkRole(auth: AuthContext, required: 'viewer' | 'editor' | 'admin') {
  const roles = ['viewer', 'editor', 'admin'];
  const userIdx = roles.indexOf(auth.role);
  const requiredIdx = roles.indexOf(required);

  if (userIdx < requiredIdx) {
    throw new Error(`Insufficient role: requires ${required}, found ${auth.role}`);
  }
}


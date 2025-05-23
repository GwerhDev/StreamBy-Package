import { Request } from 'express';
import { StreamByConfig, AuthContext } from '../types';

export async function resolveAuth(config: StreamByConfig, req: Request): Promise<AuthContext> {
  const auth = await config.authProvider(req);

  if (
    !auth ||
    !auth.userId ||
    !Array.isArray(auth.projects) ||
    auth.projects.length === 0 ||
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

export async function dummyAuthProvider(req: Request): Promise<AuthContext> {
  return {
    userId: '67ad0832cae5e7e270ee086a',
    username: 'dev-user',
    projects: [],
    role: 'admin'
  };
}

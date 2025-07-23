import { AuthContext } from '../types';

export function checkRole(auth: AuthContext, required: 'viewer' | 'editor' | 'admin') {
  const roles = ['viewer', 'editor', 'admin'];
  const userIdx = roles.indexOf(auth.role);
  const requiredIdx = roles.indexOf(required);

  if (userIdx < requiredIdx) {
    throw new Error(`Insufficient role: requires ${required}, found ${auth.role}`);
  }
}



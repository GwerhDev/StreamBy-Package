import { Request } from 'express';
import { StreamByConfig, AuthContext } from '../types';
export declare function resolveAuth(config: StreamByConfig, req: Request): Promise<AuthContext>;
export declare function checkRole(auth: AuthContext, required: 'viewer' | 'editor' | 'admin'): void;

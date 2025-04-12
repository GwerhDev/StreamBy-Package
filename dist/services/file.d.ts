import { StorageAdapter } from '../types';
import { Request } from 'express';
export declare function listFilesService(adapter: StorageAdapter, req: Request, projectId: string): Promise<any[]>;
export declare function uploadFileService(adapter: StorageAdapter, req: Request, projectId: string): Promise<any>;

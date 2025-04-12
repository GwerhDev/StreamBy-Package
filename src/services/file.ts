import { StorageAdapter } from '../types';
import { Request } from 'express';

export async function listFilesService(adapter: StorageAdapter, req: Request, projectId: string) {
  return adapter.listFiles(projectId);
}

export async function uploadFileService(adapter: StorageAdapter, req: Request, projectId: string) {
  return adapter.uploadFile(req, projectId);
}

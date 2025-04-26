import { StorageAdapter } from '../types';
import { Request } from 'express';

export async function listFilesService(adapter: StorageAdapter, req: Request, projectId: string) {
  return adapter.listFiles(projectId);
}

export async function deleteProjectImage(adapter: StorageAdapter, projectId: string) {
  if (!('deleteProjectImage' in adapter)) {
    throw new Error('StorageAdapter does not support deleting project images');
  }
  return adapter.deleteProjectImage(projectId);
}
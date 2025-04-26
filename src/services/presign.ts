import { StorageAdapter } from '../types';

export async function getPresignedUrl(adapter: StorageAdapter, filename: string, contentType: string, projectId: string) {
  if (!('getPresignedUrl' in adapter)) {
    throw new Error('StorageAdapter does not support presigned URLs');
  }
  return adapter.getPresignedUrl!(filename, contentType, projectId);
}

export async function getPresignedProjectImageUrl(adapter: StorageAdapter, projectId: string) {
  if (!('getPresignedProjectImageUrl' in adapter)) {
    throw new Error('StorageAdapter does not support presigned URLs');
  }
  return adapter.getPresignedProjectImageUrl!(projectId);
}
import { StorageAdapter } from '../types';

export async function getPresignedUrl(adapter: StorageAdapter, contentType: string, projectId: string) {
  if (!('getPresignedUrl' in adapter)) {
    throw new Error('StorageAdapter does not support presigned URLs');
  }
  return adapter.getPresignedUrl!(contentType, projectId);
}

export async function getPresignedProjectImageUrl(adapter: StorageAdapter, projectId: string) {
  if (!('getPresignedProjectImageUrl' in adapter)) {
    throw new Error('StorageAdapter does not support presigned URLs');
  }
  return adapter.getPresignedProjectImageUrl!(projectId);
}
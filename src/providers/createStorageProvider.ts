import { StorageAdapter, StorageProvider } from '../types';
import { S3Adapter } from '../adapters/s3';

export const createStorageProvider = (providers: StorageProvider[]): StorageAdapter => {
  const s3Provider = providers.find(p => p.type === 's3');
  if (s3Provider) {
    return new S3Adapter(s3Provider.config);
  }
  throw new Error('No storage provider configured.');
};
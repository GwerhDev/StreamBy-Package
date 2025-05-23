import { StorageAdapter, StorageProvider } from '../types';
import { createS3Adapter } from '../adapters/s3';

export function createStorageProvider(providers: StorageProvider[]): StorageAdapter {
  if (!providers.length) throw new Error('No storage providers configured.');

  const selected = providers[0];

  switch (selected.type) {
    case 's3':
      return createS3Adapter(selected.config);
    // futuro: case 'gcs': return createGCSAdapter(selected.config);
    default:
      throw new Error(`Unsupported storage type: ${selected.type}`);
  }
}

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { StorageAdapter, S3Config } from '../types';

export function createS3Adapter(config: S3Config): StorageAdapter {
  const s3 = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async getPresignedUrl(filename, contentType, projectId) {
      const key = `${projectId}/file-${Date.now()}-${filename}`;
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: contentType,
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 60 });
      return { url, key };
    },

    async listFiles(projectId: string) {
      const command = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${projectId}/`,
      });

      const result = await s3.send(command);
      return result.Contents || [];
    },
  };
}

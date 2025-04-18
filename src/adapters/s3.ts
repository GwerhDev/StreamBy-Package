import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { StorageAdapter, S3Config } from '../types';
import { Request } from 'express';

export function createS3Adapter(config: S3Config): StorageAdapter {
  const s3 = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async getPresignedUrl(filename, contentType) {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: `uploads/${filename}`,
        ContentType: contentType,
      });
    
      return getSignedUrl(s3, command, { expiresIn: 3600 });
    },

    async uploadFile(req: Request, projectId: string) {
      const file = req.body?.file;

      if (!file || !file.name || !file.buffer) {
        throw new Error('Invalid file upload: missing name or buffer');
      }

      const key = `${projectId}/${file.name}`;
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: file.buffer,
      });

      await s3.send(command);
      return { success: true, key };
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

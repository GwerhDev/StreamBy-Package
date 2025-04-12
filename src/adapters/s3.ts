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
    async uploadFile(req: Request, projectId: string) {
      const file = req.body.file;
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: `${projectId}/${file.name}`,
        Body: file.buffer,
      });
      await s3.send(command);
      return { success: true, key: command.input.Key };
    },

    async listFiles(projectId: string) {
      const command = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${projectId}/`
      });
      const result = await s3.send(command);
      return result.Contents || [];
    },
  };
}
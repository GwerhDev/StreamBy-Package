import {
  S3Client,
  ListObjectsV2CommandOutput,
  ObjectIdentifier,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
    async getPresignedProjectImageUrl(projectId: string) {
      const key = `${projectId}/project-image`;

      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: 'image/*',
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 60 });

      const publicUrl = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodeURIComponent(key)}`;

      return { url, publicUrl };
    },

    async getPresignedUrl(filename: string, contentType: string, projectId: string) {
      const key = `${projectId}/${contentType}/file-${Date.now()}`;

      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: contentType,
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 60 });

      const publicUrl = `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodeURIComponent(key)}`;

      return { url, publicUrl };
    },

    async listFiles(projectId: string) {
      const command = new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${projectId}/`,
      });

      const result = await s3.send(command);
      return result.Contents || [];
    },

    async deleteProjectDirectory(projectId: string): Promise<void> {
      const prefix: string = `${projectId}/`;
      let continuationToken: string | undefined = undefined;

      while (true) {
        const listCommand = new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        });

        const listedObjects: ListObjectsV2CommandOutput = await s3.send(listCommand);
        const contents = listedObjects.Contents || [];

        if (contents.length > 0) {
          const objectsToDelete: ObjectIdentifier[] = contents.map((item) => ({
            Key: item.Key!
          }));

          const deleteCommand = new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: objectsToDelete },
          });

          await s3.send(deleteCommand);
        }

        if (!listedObjects.IsTruncated) break;
        continuationToken = listedObjects.NextContinuationToken;
      }
    }
  };
}

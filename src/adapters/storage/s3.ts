import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Config, StorageAdapter } from '../../types';

export class S3Adapter implements StorageAdapter {
  private s3: S3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.s3 = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
  }

  async listFiles(projectId: string): Promise<any[]> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: `${projectId}/`,
    });
    const result = await this.s3.send(command);
    return result.Contents || [];
  }

  async deleteProjectImage(projectId: string): Promise<any> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: `${projectId}/project-image`,
    });
    return await this.s3.send(command);
  }

  async deleteProjectDirectory(projectId: string): Promise<any> {
    const listCommand = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: `${projectId}/`,
    });
    const listedObjects = await this.s3.send(listCommand);

    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      return;
    }

    const deleteParams = {
      Bucket: this.bucket,
      Delete: { Objects: listedObjects.Contents.map(({ Key }) => ({ Key })) },
    };
    const deleteCommand = new DeleteObjectCommand(deleteParams as any);
    return await this.s3.send(deleteCommand as any);
  }

  async getPresignedUrl(contentType: string, projectId: string): Promise<any> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${projectId}/${Date.now()}`,
      ContentType: contentType,
    });
    return await getSignedUrl(this.s3, command, { expiresIn: 3600 });
  }

  async getPresignedProjectImageUrl(projectId: string): Promise<any> {
    const key = `${projectId}/project-image`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: 'image/jpeg',
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
    const publicUrl = `https://${this.bucket}.s3.amazonaws.com/${key}`;
    return { url, publicUrl };
  }
}
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Config, StorageAdapter, StorageFileInfo } from '../../types';

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

  async getPresignedGetUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return await getSignedUrl(this.s3, command, { expiresIn: 86400 });
  }

  async getPresignedUploadUrl(key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return await getSignedUrl(this.s3, command, { expiresIn: 3600 });
  }

  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({ Bucket: this.bucket, Key: key });
    await this.s3.send(command);
  }

  async listFilesByCategory(projectId: string, category: string): Promise<StorageFileInfo[]> {
    const prefix = `${projectId}/${category}/`;
    const command = new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix });
    const result = await this.s3.send(command);

    if (!result.Contents || result.Contents.length === 0) return [];

    const files = await Promise.all(
      result.Contents
        .filter(obj => obj.Key && obj.Key !== prefix)
        .map(async (obj) => {
          const key = obj.Key!;
          const name = key.split('/').pop() || key;
          const url = await this.getPresignedGetUrl(key);
          return {
            key,
            name,
            size: obj.Size || 0,
            url,
            contentType: this.inferMimeType(name),
            lastModified: obj.LastModified?.toISOString() || new Date().toISOString(),
            category,
          };
        })
    );

    return files;
  }

  private inferMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
      glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj',
      fbx: 'application/octet-stream', stl: 'model/stl', ply: 'model/ply',
    };
    return ext ? (mimeMap[ext] || 'application/octet-stream') : 'application/octet-stream';
  }
}
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Config, StorageAdapter, StorageFileInfo } from '../../types';
import { sha256Base64 } from '../../utils/contentHash';

const STABLE_WINDOW_MS = 3600_000;
// The longest an S3 signed URL works (SigV4).
const MAX_SIGNED_SECONDS = 7 * 24 * 3600;

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

  // Where to upload a project's image. The bucket is private: it's read through StreamBy's
  // image route, never by a URL of the bucket.
  async getPresignedProjectImageUrl(projectId: string): Promise<{ url: string }> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${projectId}/project-image`,
      ContentType: 'image/jpeg',
    });
    return { url: await getSignedUrl(this.s3, command, { expiresIn: 3600 }) };
  }

  // The direct URLs of this bucket in a text (virtual-hosted or path style, with a region or
  // without, signed or not), and the key each one is of, decoded.
  storageUrlsIn(text: string): { url: string; key: string }[] {
    const bucket = this.bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const host = '(?:s3(?:[.-][a-z0-9-]+)?\\.amazonaws\\.com)';
    const pattern = new RegExp(
      `https?://(?:${bucket}\\.${host}/|${host}/${bucket}/)([^\\s"'<>()\\\\?#]+)(?:\\?[^\\s"'<>()\\\\#]*)?`, 'g');
    const found: { url: string; key: string }[] = [];
    for (const match of text.matchAll(pattern)) {
      let key = match[1];
      try { key = decodeURIComponent(key); } catch { /* left as it is */ }
      found.push({ url: match[0], key });
    }
    return found;
  }

  async getPresignedGetUrl(key: string, expiresIn = 86400, downloadName?: string, options: { stable?: boolean; cacheControl?: string } = {}): Promise<string> {
    if (options.stable) {
      // Signed as of the start of the hour, and valid an hour longer: every request in the same
      // hour gets the same URL, and a browser keeps (for up to an hour) what it downloaded with it.
      const windowStart = Math.floor(Date.now() / STABLE_WINDOW_MS) * STABLE_WINDOW_MS;
      const command = new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        ...(downloadName ? { ResponseContentDisposition: contentDisposition(downloadName) } : {}),
        ResponseCacheControl: options.cacheControl ?? `private, max-age=${Math.min(expiresIn, STABLE_WINDOW_MS / 1000)}`,
      });
      return await getSignedUrl(this.s3, command, {
        signingDate: new Date(windowStart),
        expiresIn: Math.min(expiresIn + STABLE_WINDOW_MS / 1000, MAX_SIGNED_SECONDS),
      });
    }
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(downloadName ? { ResponseContentDisposition: contentDisposition(downloadName) } : {}),
    });
    return await getSignedUrl(this.s3, command, { expiresIn });
  }

  async getPresignedUploadUrl(key: string, contentType: string, expiresIn = 3600, options: { sha256?: string } = {}): Promise<string> {
    if (options.sha256) {
      // The checksum is a signed header, not a query param: the upload must send it (see
      // checksumHeaders), and S3 refuses bytes that don't match it, and keeps it with the object.
      const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ChecksumSHA256: sha256Base64(options.sha256) });
      return await getSignedUrl(this.s3, command, { expiresIn, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
    }
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return await getSignedUrl(this.s3, command, { expiresIn });
  }

  async copyFile(from: string, to: string, options: { contentType?: string; cacheControl?: string } = {}): Promise<void> {
    const source = `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
    const replace = options.contentType !== undefined || options.cacheControl !== undefined;
    await this.s3.send(new CopyObjectCommand({
      Bucket: this.bucket, CopySource: source, Key: to,
      // S3 computes the copy's sha256 itself: an archived version keeps a hash to check against.
      ChecksumAlgorithm: 'SHA256',
      ...(replace ? { MetadataDirective: 'REPLACE', ContentType: options.contentType, CacheControl: options.cacheControl } : {}),
    }));
  }

  async contentInfo(key: string): Promise<{ size: number; sha256: string | null } | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }));
      // A multipart upload's checksum is of its parts ("<hash>-<parts>"), not of the file.
      const whole = head.ChecksumSHA256 && head.ChecksumType !== 'COMPOSITE' && !head.ChecksumSHA256.includes('-');
      return { size: head.ContentLength ?? 0, sha256: whole ? Buffer.from(head.ChecksumSHA256!, 'base64').toString('hex') : null };
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
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

// An attachment with its name: ASCII in `filename`, the full name in `filename*` (RFC 6266).
const contentDisposition = (name: string) => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

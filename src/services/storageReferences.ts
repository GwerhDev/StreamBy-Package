import crypto from 'crypto';
import { Request } from 'express';
import { StorageAdapter, StreamByConfig } from '../types';
import { nosqlDb } from '../utils/nosqlDb';

// The storage's bucket is private: nothing reads it by a direct URL. What StreamBy answers in
// place of one is a URL of its own routes (a project's image) or a signed URL of the key
// (what an export serves), and an asset is referred to as `streamby://asset/<fileId>`,
// resolved to its current version when the export is answered.

export const ASSET_REFERENCE = 'streamby://asset/';
const ASSET_REFERENCES = /streamby:\/\/asset\/([A-Za-z0-9_-]+)/g;

// How long a signed URL answered in an export works (stable within each hour: the same URL for
// every request in it, so a browser keeps what it downloaded).
const SIGNED_SECONDS = 24 * 3600;

/** Where this router is reached from outside, without a trailing slash (see publicBaseUrl). */
export const publicBaseOf = (req: Request, config: Pick<StreamByConfig, 'publicBaseUrl'>) =>
  (config.publicBaseUrl ?? `${req.protocol}://${req.get('host')}${req.baseUrl}`).replace(/\/+$/, '');

export const projectImagePath = (projectId: string) => `/${projectId}/image`;
/** Where a project's own image is stored. */
export const projectImageStorageKey = (projectId: string) => `${projectId}/project-image`;

/**
 * The key a project's image is read from: its own (`<project>/project-image`), or the key of
 * the project's storage its stored URL points at. Null when it has none, or it's somewhere else
 * (an external URL, answered as it is).
 */
export function projectImageKey(project: any, adapter: StorageAdapter | undefined): string | null {
  const projectId = String(project?._id ?? project?.id ?? '');
  const stored: string = typeof project?.image === 'string' ? project.image.trim() : '';
  if (!projectId || !stored) return null;
  if (stored.split('?')[0].endsWith(projectImagePath(projectId))) return projectImageStorageKey(projectId);
  const [found] = adapter?.storageUrlsIn?.(stored) ?? [];
  return found && found.key.startsWith(`${projectId}/`) ? found.key : null;
}

/**
 * A project's image as StreamBy answers it: its image route (with a version, so a new image is a
 * new URL), never the bucket's; an external URL as it is; '' when it has none.
 */
export function projectImageUrl(project: any, base: string, adapter: StorageAdapter | undefined): string {
  const stored: string = typeof project?.image === 'string' ? project.image.trim() : '';
  if (!projectImageKey(project, adapter)) return stored;
  const projectId = String(project._id ?? project.id);
  const given = /[?&]v=([A-Za-z0-9_-]+)/.exec(stored)?.[1];
  const version = given ?? crypto.createHash('sha256').update(stored).digest('hex').slice(0, 10);
  return `${base}${projectImagePath(projectId)}?v=${version}`;
}

/** What a new project image is saved as: its route, with a version of its own. */
export const newProjectImageUrl = (base: string, projectId: string) =>
  `${base}${projectImagePath(projectId)}?v=${Date.now().toString(36)}`;

const stringsIn = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => stringsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => stringsIn(v, out));
  return out;
};

const mapStrings = (value: unknown, map: (s: string) => string): unknown => {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, map));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, map)]));
  }
  return value;
};

/**
 * An export's data as it's answered: each direct URL of the project's own storage in it (a key
 * under the project's prefix; another project's, or another storage's, stays as it is) and each
 * `streamby://asset/<fileId>` of the project's (its current version) become a signed URL.
 */
export async function resolveStorageReferences(data: unknown, project: any, adapter: StorageAdapter | undefined): Promise<unknown> {
  if (!adapter?.getPresignedGetUrl || data === null || data === undefined) return data;
  const projectId = String(project._id ?? project.id);
  const strings = stringsIn(data);
  const own = `${projectId}/`;

  const urls = new Map<string, string>(); // a direct URL → its key
  const assetIds = new Set<string>();
  for (const s of strings) {
    for (const { url, key } of adapter.storageUrlsIn?.(s) ?? []) if (key.startsWith(own)) urls.set(url, key);
    for (const match of s.matchAll(ASSET_REFERENCES)) assetIds.add(match[1]);
  }
  if (!urls.size && !assetIds.size) return data;

  // An asset's current version is at its own key; one in another storage connection isn't
  // this storage's to sign, and is left as it is. A file of the built-in storage has no
  // connection, or its connection's id, or (uploaded before connections had ids of their own)
  // the built-in provider's.
  const assetKeys = new Map<string, string>();
  if (assetIds.size) {
    const files = await nosqlDb()?.collection('storage_files').find({ projectId, fileId: { $in: [...assetIds] } }).toArray() ?? [];
    const builtin = new Set<string>();
    for (const c of project.storageConnections ?? []) if (c?.source === 'builtin') { builtin.add(c.id); if (c.integrationId) builtin.add(c.integrationId); }
    for (const file of files as any[]) {
      if (file.storageConnectionId && !builtin.has(file.storageConnectionId)) continue;
      if (typeof file.storageKey === 'string' && file.storageKey.startsWith(own)) assetKeys.set(file.fileId, file.storageKey);
    }
  }

  const signed = new Map<string, string>();
  const sign = async (key: string) => {
    if (!signed.has(key)) signed.set(key, await adapter.getPresignedGetUrl!(key, SIGNED_SECONDS, undefined, { stable: true }));
  };
  for (const key of [...urls.values(), ...assetKeys.values()]) await sign(key);

  return mapStrings(data, s => {
    let out = s;
    for (const [url, key] of urls) if (out.includes(url)) out = out.split(url).join(signed.get(key)!);
    return out.replace(ASSET_REFERENCES, (whole, fileId) => {
      const key = assetKeys.get(fileId);
      return key ? signed.get(key)! : whole;
    });
  });
}

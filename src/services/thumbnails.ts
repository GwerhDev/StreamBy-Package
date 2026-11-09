import { StorageAdapter, StreamByConfig } from '../types';
import { nosqlDb } from '../utils/nosqlDb';
import { activeMemberOf } from '../utils/auth';
import { emitToUser } from './wsHub';
import { withFfmpeg } from './localWorker';

// An image's or a video's thumbnail, for the lists that show it: a small WebP (320 px wide) kept
// beside the file in its storage (`<its key>.thumb.webp`), never an asset of the project. It's
// made the first time a list shows the file without a thumbnail of what the file is now (made
// before, or replaced since), in the background, on this server, with FFmpeg: the list answers
// at once, and the project's members get an `assetThumbnailEvent` with its URL when it's ready.
// One that can't be made (no FFmpeg, the file not uploaded yet) is tried again a while later.

export const THUMBNAIL_WIDTH = 320;
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_AT_ONCE = 2;
const TAKES = ['images', 'videos'];

const files = () => nosqlDb()?.collection('storage_files') ?? null;

/** What a file's thumbnail is of: the file as it is now (a replaced file is another). */
const sourceOf = (file: any) => new Date(file.updatedAt ?? file.createdAt ?? 0).toISOString();

export const thumbnailKeyOf = (file: { storageKey: string }) => `${file.storageKey}.thumb.webp`;

/** Its thumbnail's key, if it has one of what it is now. */
export function freshThumbnail(file: any): string | null {
  return file.thumbnail?.source === sourceOf(file) && file.thumbnail.storageKey ? file.thumbnail.storageKey : null;
}

// ── Making them, a few at a time ──

const making = new Set<string>();
const waiting: (() => Promise<void>)[] = [];
let running = 0;

function next() {
  while (running < MAX_AT_ONCE && waiting.length) {
    const job = waiting.shift()!;
    running++;
    job().finally(() => { running--; next(); });
  }
}

interface Context { project: any; config: StreamByConfig; adapter: StorageAdapter; signedUrl: (key: string) => Promise<string | null> }

/** Asks for a file's thumbnail, if it should have one and has none of what it is now. */
export function requestThumbnail(file: any, ctx: Context): void {
  if (!TAKES.includes(file.category) || freshThumbnail(file) || ctx.config.processing === false) return;
  if (!ctx.adapter.getPresignedGetUrl || !ctx.adapter.getPresignedUploadUrl) return;
  const failed = file.thumbnailFailure;
  if (failed?.source === sourceOf(file) && Date.now() - new Date(failed.at).getTime() < RETRY_AFTER_MS) return;
  const id = `${file.projectId}:${file.fileId}:${sourceOf(file)}`;
  if (making.has(id)) return;
  making.add(id);
  waiting.push(() => makeThumbnail(file, ctx).finally(() => making.delete(id)));
  next();
}

async function makeThumbnail(file: any, ctx: Context): Promise<void> {
  const col = files();
  if (!col) return;
  const source = sourceOf(file);
  try {
    const res = await fetch((await ctx.adapter.getPresignedGetUrl!(file.storageKey, 600))!, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) throw new Error(`its file couldn't be downloaded (${res.status})`);
    const bytes = await withFfmpeg(ctx.config, {
      bytes: Buffer.from(await res.arrayBuffer()), fileName: file.displayName ?? 'file', contentType: file.contentType ?? '', category: file.category,
    }, (inFile, outFile) => [
      ...(file.category === 'videos' ? ['-ss', '00:00:01'] : []), '-i', inFile, '-frames:v', '1', '-vf', `scale='min(${THUMBNAIL_WIDTH},iw)':-2`, '-q:v', '75', outFile,
    ], 'thumb.webp');
    const storageKey = thumbnailKeyOf(file);
    const put = await fetch(await ctx.adapter.getPresignedUploadUrl!(storageKey, 'image/webp', 600), {
      method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: new Uint8Array(bytes),
    });
    if (!put.ok) throw new Error(`it couldn't be uploaded (${put.status})`);
    // Only if the file is still what it was made of (not replaced meanwhile).
    const kept = await col.updateOne(
      { projectId: file.projectId, fileId: file.fileId, storageKey: file.storageKey },
      { $set: { thumbnail: { storageKey, source, at: new Date() } }, $unset: { thumbnailFailure: '' } },
    );
    if (!kept.modifiedCount) return;
    const thumbnailUrl = await ctx.signedUrl(storageKey);
    for (const member of ctx.project?.members ?? []) {
      if (activeMemberOf(ctx.project, member.userId)) {
        emitToUser(member.userId, { type: 'assetThumbnailEvent', data: { projectId: file.projectId, fileId: file.fileId, thumbnailUrl } });
      }
    }
  } catch (err: any) {
    await col.updateOne({ projectId: file.projectId, fileId: file.fileId }, { $set: { thumbnailFailure: { source, at: new Date(), error: String(err?.message ?? err).slice(0, 300) } } }).catch(() => {});
  }
}

/** Waits for the thumbnails being made (for tests). */
export async function thumbnailsSettled(): Promise<void> {
  while (running || waiting.length) await new Promise(resolve => setTimeout(resolve, 20));
}

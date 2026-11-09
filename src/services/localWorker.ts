import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import type { NodeIO, Document as GltfDocument } from '@gltf-transform/core';
import { StorageAdapter, StorageCategoryName, StreamByConfig, WorkerConfig } from '../types';
import { STORAGE_CATEGORIES, WorkerError } from './workers';
import { authorizeCallback, completeJobWithDocument, completeJob, failWorkerJob, reportProgress, resultUploadUrl } from './workerJobs';
import { getJob } from './jobQueue';
import { getDecryptedIntegrationCredential } from './userIntegration';
import { CompatibleCredential, isSpeechProvider, transcribe } from './speechProviders';
import { documentStore } from './documents';

// StreamBy's own worker: what it processes itself, on the server it runs on, with the same
// contract as an external worker (see workerJobs): it's sent a job, downloads the asset, and
// uploads its result, which is kept as a new asset derived from it (or its new version). Off with
// `processing: false` in the router's config.
//
//   thumbnail     an image's, or a video's frame, as an image (FFmpeg)
//   transcode     a video or an audio in another format, codec, size or bitrate (FFmpeg)
//   lod           a glTF model with fewer triangles (glTF-Transform and meshoptimizer)
//   gltf-convert  a glTF model as .glb, or as .gltf with its buffers inside it
//   transcribe    a video's or an audio's text, as a project document, with a speech provider
//                 the requester connected (an account integration: OpenAI, Deepgram, AssemblyAI,
//                 or any OpenAI-compatible service)
//
// FFmpeg is the host's (config.processing.ffmpegPath, `ffmpeg` by default): where there's none,
// its jobs fail saying so.

export const LOCAL_WORKER_ID = 'streamby';
export const LOCAL_ENDPOINT = 'local:streamby';
export const LOCAL_KINDS = ['thumbnail', 'transcode', 'lod', 'gltf-convert', 'transcribe'] as const;
type Kind = typeof LOCAL_KINDS[number];

type RouterConfig = StreamByConfig & { adapter?: StorageAdapter };

/** StreamBy's own worker, as a built-in one: none when the host turned it off. */
export function localWorkerConfig(config: StreamByConfig): WorkerConfig | null {
  if (config.processing === false) return null;
  return {
    id: LOCAL_WORKER_ID, name: 'StreamBy', endpoint: LOCAL_ENDPOINT,
    kinds: [...LOCAL_KINDS], categories: [...STORAGE_CATEGORIES], autoKind: null, timeoutSeconds: 3600,
  };
}

export interface Input { bytes: Buffer; fileName: string; contentType: string; category: StorageCategoryName }
type Output =
  | { file: { bytes: Buffer; fileName: string; contentType: string; category: StorageCategoryName }; report: Record<string, unknown> }
  | { document: { title: string; content: string }; report: Record<string, unknown> };
interface Context { config: RouterConfig; userId: string; projectId: string; assetName: string }

const baseName = (fileName: string) => fileName.replace(/\.[^./]+$/, '');
const extOf = (fileName: string) => (fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '');
const requireCategory = (input: Input, categories: StorageCategoryName[], what: string) => {
  if (!categories.includes(input.category)) throw new WorkerError(`${what} takes ${categories.join(' or ')}, not ${input.category}`);
};

// ── FFmpeg ──

const ffmpegPath = (config: StreamByConfig) => (config.processing && config.processing.ffmpegPath) || 'ffmpeg';

/** Runs FFmpeg on a file, in a folder of its own: the bytes of what it writes. */
export async function withFfmpeg(config: StreamByConfig, input: Input, args: (inFile: string, outFile: string) => string[], outName: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamby-'));
  try {
    const inFile = path.join(dir, `in.${extOf(input.fileName) || 'bin'}`);
    const outFile = path.join(dir, outName);
    await fs.writeFile(inFile, input.bytes);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath(config), ['-hide_banner', '-loglevel', 'error', '-y', ...args(inFile, outFile)]);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', err => reject((err as NodeJS.ErrnoException).code === 'ENOENT'
        ? new WorkerError("FFmpeg isn't available on this server")
        : err));
      child.on('close', code => (code === 0 ? resolve() : reject(new WorkerError(`FFmpeg couldn't process it: ${stderr.trim().split('\n').pop() ?? `exit ${code}`}`))));
    });
    return await fs.readFile(outFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const IMAGE_FORMATS: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const VIDEO_FORMATS: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const AUDIO_FORMATS: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac' };

const positiveInt = (value: unknown, name: string, fallback?: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 16384) throw new WorkerError(`${name} must be a whole number of pixels`);
  return n;
};
const timecode = (value: unknown) => {
  const t = value === undefined ? '00:00:01' : String(value);
  if (!/^(\d+:)?(\d+:)?\d+(\.\d+)?$/.test(t)) throw new WorkerError('timecode must be like 00:00:01 or 1.5');
  return t;
};
const bitrate = (value: unknown, name: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d+[kKmM]?$/.test(String(value))) throw new WorkerError(`${name} must be like 128k or 2M`);
  return String(value);
};

async function thumbnail(input: Input, profile: any, ctx: Context): Promise<Output> {
  requireCategory(input, ['images', 'videos'], 'A thumbnail');
  const format = profile.format ?? 'jpg';
  if (!IMAGE_FORMATS[format]) throw new WorkerError(`format must be one of ${Object.keys(IMAGE_FORMATS).join(', ')}`);
  const width = positiveInt(profile.width, 'width', 640)!;
  const at = input.category === 'videos' ? timecode(profile.timecode) : null;
  const outName = `${baseName(input.fileName)}-thumbnail.${format}`;
  const bytes = await withFfmpeg(ctx.config, input, (inFile, outFile) => [
    ...(at ? ['-ss', at] : []), '-i', inFile, '-frames:v', '1', '-vf', `scale=${width}:-2`, outFile,
  ], `out.${format}`);
  return { file: { bytes, fileName: outName, contentType: IMAGE_FORMATS[format], category: 'images' }, report: { width, ...(at ? { timecode: at } : {}) } };
}

async function transcode(input: Input, profile: any, ctx: Context): Promise<Output> {
  requireCategory(input, ['videos', 'audios'], 'A transcode');
  const format = String(profile.format ?? (input.category === 'videos' ? 'mp4' : 'mp3'));
  const toVideo = !!VIDEO_FORMATS[format];
  if (!toVideo && !AUDIO_FORMATS[format]) throw new WorkerError(`format must be one of ${[...Object.keys(VIDEO_FORMATS), ...Object.keys(AUDIO_FORMATS)].join(', ')}`);
  if (toVideo && input.category === 'audios') throw new WorkerError("An audio can't become a video");
  const width = positiveInt(profile.width, 'width');
  const height = positiveInt(profile.height, 'height');
  const videoBitrate = bitrate(profile.videoBitrate, 'videoBitrate');
  const audioBitrate = bitrate(profile.audioBitrate, 'audioBitrate');
  const scale = width || height ? ['-vf', `scale=${width ?? -2}:${height ?? -2}`] : [];
  const bytes = await withFfmpeg(ctx.config, input, (inFile, outFile) => [
    '-i', inFile,
    ...(toVideo ? [...scale, ...(videoBitrate ? ['-b:v', videoBitrate] : [])] : ['-vn']),
    ...(audioBitrate ? ['-b:a', audioBitrate] : []),
    ...(format === 'mp4' ? ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'] : []),
    outFile,
  ], `out.${format}`);
  const category: StorageCategoryName = toVideo ? 'videos' : 'audios';
  return {
    file: { bytes, fileName: `${baseName(input.fileName)}.${format}`, contentType: toVideo ? VIDEO_FORMATS[format] : AUDIO_FORMATS[format], category },
    report: { format, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(videoBitrate ? { videoBitrate } : {}), ...(audioBitrate ? { audioBitrate } : {}) },
  };
}

// ── glTF ──

// glTF-Transform and meshoptimizer are loaded when a glTF job needs them, not when StreamBy
// starts: they're ES modules (or need some), and built as CommonJS an import() is a require(),
// which Node takes for an ES module only since 22.12. An older Node is asked for a real import(),
// so StreamBy starts, and processes glTF, on either.
const realImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
async function esm<T>(load: () => Promise<T>, specifier: string): Promise<T> {
  try {
    return await load();
  } catch (err: any) {
    if (err?.code !== 'ERR_REQUIRE_ESM') throw err;
    return realImport(specifier);
  }
}
const loadCore = () => esm(() => import('@gltf-transform/core'), '@gltf-transform/core');
const loadFunctions = () => esm(() => import('@gltf-transform/functions'), '@gltf-transform/functions');
const loadMeshoptimizer = () => esm(() => import('meshoptimizer'), 'meshoptimizer');

async function readGltf(input: Input): Promise<{ io: NodeIO; document: GltfDocument }> {
  requireCategory(input, ['3d-models'], 'It');
  const { NodeIO: IO } = await loadCore();
  const io = new IO();
  const ext = extOf(input.fileName);
  if (ext === 'glb') return { io, document: await io.readBinary(new Uint8Array(input.bytes)) };
  if (ext === 'gltf') {
    let json: any;
    try { json = JSON.parse(input.bytes.toString('utf8')); } catch { throw new WorkerError("It isn't a valid .gltf file"); }
    // Only its buffers inside it (data: URIs): a .gltf with files beside it has them elsewhere.
    if ((json.buffers ?? []).some((b: any) => b.uri && !String(b.uri).startsWith('data:'))) {
      throw new WorkerError('A .gltf with its buffers in other files: upload it as .glb');
    }
    return { io, document: await io.readJSON({ json, resources: {} }) };
  }
  throw new WorkerError('It takes a glTF model (.glb or .gltf)');
}

const triangles = (document: GltfDocument) => document.getRoot().listMeshes().reduce((sum, mesh) =>
  sum + mesh.listPrimitives().reduce((s, p) => s + Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3), 0), 0);

async function writeGlb(io: NodeIO, document: GltfDocument, name: string, report: Record<string, unknown>): Promise<Output> {
  return { file: { bytes: Buffer.from(await io.writeBinary(document)), fileName: `${name}.glb`, contentType: 'model/gltf-binary', category: '3d-models' }, report };
}

async function lod(input: Input, profile: any): Promise<Output> {
  const ratio = profile.ratio === undefined ? 0.5 : Number(profile.ratio);
  if (!(ratio > 0 && ratio < 1)) throw new WorkerError('ratio must be between 0 and 1 (the share of triangles kept)');
  const error = profile.error === undefined ? 0.01 : Number(profile.error);
  if (!(error >= 0 && error <= 1)) throw new WorkerError('error must be between 0 and 1');
  const { io, document } = await readGltf(input);
  const before = triangles(document);
  const { MeshoptSimplifier } = await loadMeshoptimizer();
  const { simplify, weld } = await loadFunctions();
  await MeshoptSimplifier.ready;
  await document.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error }));
  return writeGlb(io, document, `${baseName(input.fileName)}-lod${Math.round(ratio * 100)}`, { ratio, error, triangles: { before, after: triangles(document) } });
}

async function gltfConvert(input: Input, profile: any): Promise<Output> {
  const to = profile.to ?? (extOf(input.fileName) === 'glb' ? 'gltf' : 'glb');
  if (to !== 'glb' && to !== 'gltf') throw new WorkerError("to must be 'glb' or 'gltf'");
  const { io, document } = await readGltf(input);
  if (to === 'glb') return writeGlb(io, document, baseName(input.fileName), { to });
  // One file: its buffers inside it.
  const { json, resources } = await io.writeJSON(document);
  for (const buffer of json.buffers ?? []) {
    const data = buffer.uri ? resources[buffer.uri] : undefined;
    if (data) buffer.uri = `data:application/octet-stream;base64,${Buffer.from(data).toString('base64')}`;
  }
  return { file: { bytes: Buffer.from(JSON.stringify(json)), fileName: `${baseName(input.fileName)}.gltf`, contentType: 'model/gltf+json', category: '3d-models' }, report: { to } };
}

// ── Transcription ──

async function transcribeAsset(input: Input, profile: any, ctx: Context): Promise<Output> {
  requireCategory(input, ['videos', 'audios'], 'A transcription');
  if (typeof profile.integrationId !== 'string' || !profile.integrationId) {
    throw new WorkerError('integrationId is required: one of your speech provider integrations (OpenAI, Deepgram, AssemblyAI, or an OpenAI-compatible service)');
  }
  // The requester's own: never another member's credential.
  const resolved = await getDecryptedIntegrationCredential(ctx.userId, profile.integrationId, ctx.config);
  if (!resolved || !isSpeechProvider(resolved.provider)) throw new WorkerError("integrationId must be one of your speech provider integrations", 404);
  const credential = resolved.provider === 'openai-compatible' ? JSON.parse(String(resolved.credential)) as CompatibleCredential : String(resolved.credential);
  // Its audio only, small: what every provider takes.
  const audio = await withFfmpeg(ctx.config, input, (inFile, outFile) => ['-i', inFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', outFile], 'audio.mp3');
  const language = typeof profile.language === 'string' && profile.language ? profile.language : undefined;
  const model = typeof profile.model === 'string' && profile.model ? profile.model : undefined;
  const { text, language: detected } = await transcribe(resolved.provider, credential, { bytes: audio, fileName: 'audio.mp3', contentType: 'audio/mpeg' }, { language, model }, ctx.config);
  if (!text) throw new WorkerError('The provider found no speech in it');
  return {
    document: { title: `Transcript of ${ctx.assetName}`, content: text },
    report: { provider: resolved.provider, ...(detected ? { language: detected } : {}), characters: text.length },
  };
}

const PROCESSORS: Record<Kind, (input: Input, profile: any, ctx: Context) => Promise<Output>> = {
  thumbnail, transcode, lod, 'gltf-convert': gltfConvert, transcribe: transcribeAsset,
};

// ── Its job ──

/** What StreamBy's own worker is sent (as an external one is, see dispatchJob). */
export interface LocalJobBody {
  jobId: string;
  kind: string;
  profile: Record<string, unknown>;
  asset: { id: string; versionId: string | null; fileName: string; contentType: string | null; category: StorageCategoryName };
  download: { url: string };
  callback: { token: string };
}

/** StreamBy's own worker takes a job: as an external worker would, through the job's contract. */
export async function runLocalJob(body: LocalJobBody, config: RouterConfig): Promise<void> {
  const authorization = `Bearer ${body.callback.token}`;
  const current = () => authorizeCallback(body.jobId, authorization);
  try {
    const job = await current();
    const processor = PROCESSORS[body.kind as Kind];
    if (!processor) throw new WorkerError(`StreamBy doesn't do ${body.kind}`);
    await reportProgress(job, { stage: 'downloading', progress: 5 });
    const res = await fetch(body.download.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new WorkerError(`Its asset couldn't be downloaded (${res.status})`);
    const input: Input = {
      bytes: Buffer.from(await res.arrayBuffer()), fileName: body.asset.fileName,
      contentType: body.asset.contentType ?? 'application/octet-stream', category: body.asset.category,
    };
    await reportProgress(await current(), { stage: body.kind, progress: 30 });
    const output = await processor(input, body.profile ?? {}, { config, userId: job.userId, projectId: job.projectId, assetName: body.asset.fileName });

    if ('document' in output) {
      const now = new Date();
      const author = { userId: job.userId, username: job.payload?.requester?.username ?? '', via: 'session' as const };
      const siblings = (await documentStore().list(job.projectId)).filter(d => d.parentId === null);
      const document = await documentStore().create({
        id: crypto.randomUUID(), projectId: job.projectId, kind: 'document', title: output.document.title, parentId: null,
        position: siblings.length ? Math.max(...siblings.map(d => d.position)) + 1 : 0, content: output.document.content,
        version: 1, exportable: false, publishedVersion: null, createdAt: now, createdBy: author, updatedAt: now, updatedBy: author,
      } as any);
      await completeJobWithDocument(await current(), document.id, output.report);
      return;
    }

    await reportProgress(await current(), { stage: 'uploading', progress: 80 });
    const { file } = output;
    const upload = await resultUploadUrl(await current(), { fileName: file.fileName, contentType: file.contentType, category: file.category }, config);
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(file.bytes) });
    if (!put.ok) throw new WorkerError(`Its result couldn't be uploaded (${put.status})`);
    await completeJob(await current(), { report: output.report }, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof WorkerError)) console.error(`❌ StreamBy processing: job ${body.jobId} failed:`, message);
    const job = await getJob(body.jobId);
    // Still its own (not timed out and sent again): failed, with what went wrong.
    if (job?.status === 'processing') {
      await failWorkerJob(job, { error: message, retryable: false }, config).catch(() => {});
    }
  }
}

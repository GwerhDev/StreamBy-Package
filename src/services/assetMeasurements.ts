import crypto from 'crypto';

// What an asset's version measures, and the project's budgets it's checked against: a 3D one's
// triangles, materials, textures and animations; an audio one's format, loudness (LUFS), true
// peak, RMS and loudness range. StreamBy measures nothing itself: whoever opens the version
// measures it (the inspector in the UI, in the browser; later a worker or a local tool) and
// sends the measurements, which are checked here and kept with the version.

/** What an asset is measured as: by its Storage category (3d-models, audios). */
export type MeasuredKind = 'model' | 'audio';
export const kindOfCategory = (category: unknown): MeasuredKind | null =>
  category === '3d-models' ? 'model' : category === 'audios' ? 'audio' : null;

export interface MeasuredTexture {
  name: string | null;
  width: number;
  height: number;
  // Its MIME type (image/png, image/jpeg, image/webp, image/ktx2...), null if unknown.
  format: string | null;
}

export interface MeasuredAnimation {
  name: string | null;
  // Seconds.
  duration: number;
}

export interface ModelMeasurements {
  kind: 'model';
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
  textures: MeasuredTexture[];
  animations: MeasuredAnimation[];
  measuredAt: Date;
  measuredBy: string;
  // What measured it (e.g. 'streamby-inspector').
  tool: string | null;
}

/**
 * What an audio file measures. Loudness is ITU-R BS.1770 / EBU R 128: integrated and the loudest
 * short-term (3 s) loudness in LUFS, the loudness range (LRA) in LU; true peak in dBTP; RMS in
 * dBFS. A level is null where there's nothing to measure (silence).
 */
export interface AudioMeasurements {
  kind: 'audio';
  // Seconds.
  duration: number;
  sampleRate: number;
  channels: number;
  // Bits per sample of a PCM file (a WAV's); null for a compressed one.
  bitDepth: number | null;
  // Its MIME type (audio/wav, audio/ogg, audio/mpeg...), null if unknown.
  format: string | null;
  integratedLufs: number | null;
  shortTermLufsMax: number | null;
  truePeak: number | null;
  rms: number | null;
  lra: number | null;
  measuredAt: Date;
  measuredBy: string;
  tool: string | null;
}

export type Measurements = ModelMeasurements | AudioMeasurements;

/** One kind of piece's budget: the most it may have of each (a limit not set isn't checked). */
export interface BudgetProfile {
  id: string;
  name: string;
  // What it budgets: 3D assets (the default) or audio ones (music, SFX, dialogue, ambience...).
  kind?: MeasuredKind;
  maxTriangles?: number;
  maxMaterials?: number;
  maxTextures?: number;
  // The longest side a texture may have, in pixels.
  maxTextureSize?: number;
  // The texture formats it may use (MIME types); any if not set.
  textureFormats?: string[];
  maxAnimations?: number;
  // Audio: the integrated loudness it's mixed to (LUFS) and how far from it it may be (LU).
  targetLufs?: number;
  lufsTolerance?: number;
  // Audio: the highest true peak it may reach (dBTP).
  maxTruePeak?: number;
  // Audio: the formats (MIME types) and sample rates (Hz) it may be in; any if not set.
  audioFormats?: string[];
  sampleRates?: number[];
}

export interface AssetBudgets {
  profiles: BudgetProfile[];
  // The profile a 3D asset that chose none is checked against; none if null.
  defaultProfileId: string | null;
  // The same, for an audio asset.
  defaultAudioProfileId: string | null;
}

/** What a version has over its budget. */
export interface Exceeded {
  metric: 'triangles' | 'materials' | 'textures' | 'textureSize' | 'textureFormat' | 'animations'
    | 'loudness' | 'truePeak' | 'audioFormat' | 'sampleRate';
  limit: number | string[] | number[];
  value: number | string;
  // The texture it's about, for a texture's size or format.
  texture?: string | null;
  // For loudness: how far from its target (limit) it may be, in LU.
  tolerance?: number;
}

export const EMPTY_BUDGETS: AssetBudgets = { profiles: [], defaultProfileId: null, defaultAudioProfileId: null };

const MAX_ITEMS = 1000;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isLimit = (v: unknown) => v === undefined || v === null || isCount(v);
const nameOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

type Checked<T> = T | { error: string };

/** Measurements as sent for an asset of a kind, checked. */
export function checkMeasurements(body: any, measuredBy: string, kind: MeasuredKind = 'model'): Checked<Measurements> {
  if (!body || typeof body !== 'object') return { error: 'The measurements are an object' };
  return kind === 'audio' ? checkAudioMeasurements(body, measuredBy) : checkModelMeasurements(body, measuredBy);
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// A level in dB/LUFS: a number, or null where there's nothing to measure. It can't be loud past
// what a file holds (true peak, RMS and LUFS of a sane mix stay well under +30).
const isLevel = (v: unknown) => v === null || (isNumber(v) && v >= -200 && v <= 30);
const LEVELS = ['integratedLufs', 'shortTermLufsMax', 'truePeak', 'rms'] as const;

function checkAudioMeasurements(body: any, measuredBy: string): Checked<AudioMeasurements> {
  if (!isNumber(body.duration) || body.duration < 0) return { error: 'duration is in seconds, 0 or more' };
  if (!isCount(body.sampleRate) || body.sampleRate < 1) return { error: 'sampleRate is in Hz, a whole number' };
  if (!isCount(body.channels) || body.channels < 1 || body.channels > 64) return { error: 'channels is a whole number, 1 to 64' };
  if (body.bitDepth !== undefined && body.bitDepth !== null && (!isCount(body.bitDepth) || body.bitDepth < 1 || body.bitDepth > 64)) {
    return { error: 'bitDepth is bits per sample, or null for a compressed file' };
  }
  if (body.format !== undefined && body.format !== null && typeof body.format !== 'string') return { error: 'format is its MIME type' };
  for (const key of LEVELS) {
    if (body[key] === undefined || !isLevel(body[key])) return { error: `${key} is a level (dB or LUFS), or null where there's nothing to measure` };
  }
  if (body.lra !== null && (!isNumber(body.lra) || body.lra < 0 || body.lra > 100)) return { error: 'lra is in LU, 0 or more, or null' };
  const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    kind: 'audio',
    duration: Math.round(body.duration * 1000) / 1000,
    sampleRate: body.sampleRate,
    channels: body.channels,
    bitDepth: body.bitDepth ?? null,
    format: typeof body.format === 'string' ? body.format.toLowerCase() : null,
    integratedLufs: round(body.integratedLufs),
    shortTermLufsMax: round(body.shortTermLufsMax),
    truePeak: round(body.truePeak),
    rms: round(body.rms),
    lra: round(body.lra),
    measuredAt: new Date(),
    measuredBy,
    tool: nameOf(body.tool),
  };
}

/** A 3D asset's measurements, checked (counts are whole numbers, at most 1000 textures/animations). */
function checkModelMeasurements(body: any, measuredBy: string): Checked<ModelMeasurements> {
  for (const key of ['triangles', 'vertices', 'meshes', 'materials'] as const) {
    if (!isCount(body[key])) return { error: `${key} is a whole number, 0 or more` };
  }
  const textures = body.textures ?? [];
  const animations = body.animations ?? [];
  if (!Array.isArray(textures) || textures.length > MAX_ITEMS) return { error: `textures is a list of at most ${MAX_ITEMS}` };
  if (!Array.isArray(animations) || animations.length > MAX_ITEMS) return { error: `animations is a list of at most ${MAX_ITEMS}` };
  for (const t of textures) {
    if (!t || !isCount(t.width) || !isCount(t.height)) return { error: "Each texture has its width and height, in pixels" };
    if (t.format !== undefined && t.format !== null && typeof t.format !== 'string') return { error: "A texture's format is its MIME type" };
  }
  for (const a of animations) {
    if (!a || typeof a.duration !== 'number' || !Number.isFinite(a.duration) || a.duration < 0) return { error: "Each animation has its duration, in seconds" };
  }
  return {
    kind: 'model',
    triangles: body.triangles,
    vertices: body.vertices,
    meshes: body.meshes,
    materials: body.materials,
    textures: textures.map((t: any) => ({ name: nameOf(t.name), width: t.width, height: t.height, format: typeof t.format === 'string' ? t.format.toLowerCase() : null })),
    animations: animations.map((a: any) => ({ name: nameOf(a.name), duration: a.duration })),
    measuredAt: new Date(),
    measuredBy,
    tool: nameOf(body.tool),
  };
}

const MODEL_LIMITS = ['maxTriangles', 'maxMaterials', 'maxTextures', 'maxTextureSize', 'maxAnimations'] as const;
const formatsOf = (v: unknown) => Array.isArray(v) && v.every(f => typeof f === 'string' && f.trim());

/** A project's budgets as sent, checked: each profile named, its limits of its kind. */
export function checkBudgets(body: any): Checked<AssetBudgets> {
  if (!body || !Array.isArray(body.profiles)) return { error: 'The budgets are { profiles: [...], defaultProfileId, defaultAudioProfileId }' };
  if (body.profiles.length > 100) return { error: 'At most 100 profiles' };
  const profiles: BudgetProfile[] = [];
  for (const p of body.profiles) {
    const name = nameOf(p?.name);
    if (!name) return { error: 'Each profile has a name' };
    const kind: MeasuredKind = p.kind === 'audio' ? 'audio' : 'model';
    if (p.kind !== undefined && p.kind !== null && p.kind !== 'model' && p.kind !== 'audio') return { error: `${name}: kind is model or audio` };
    const id = typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID();
    if (profiles.some(q => q.id === id)) return { error: `Two profiles have the id ${id}` };
    if (profiles.some(q => q.name.toLowerCase() === name.toLowerCase())) return { error: `Two profiles are named ${name}` };

    if (kind === 'model') {
      for (const key of MODEL_LIMITS) {
        if (!isLimit(p[key])) return { error: `${name}: ${key} is a whole number, 0 or more` };
      }
      if (p.textureFormats !== undefined && p.textureFormats !== null && !formatsOf(p.textureFormats)) {
        return { error: `${name}: textureFormats is a list of MIME types (image/png, image/ktx2...)` };
      }
      const limits = Object.fromEntries(MODEL_LIMITS.filter(k => isCount(p[k])).map(k => [k, p[k]]));
      profiles.push({
        id, name, ...limits,
        ...(Array.isArray(p.textureFormats) ? { textureFormats: p.textureFormats.map((f: string) => f.trim().toLowerCase()) } : {}),
      });
      continue;
    }

    const optionalNumber = (v: unknown) => v === undefined || v === null || isNumber(v);
    if (!optionalNumber(p.targetLufs) || (isNumber(p.targetLufs) && (p.targetLufs < -70 || p.targetLufs > 0))) {
      return { error: `${name}: targetLufs is a loudness in LUFS (e.g. -14), -70 to 0` };
    }
    if (!optionalNumber(p.lufsTolerance) || (isNumber(p.lufsTolerance) && p.lufsTolerance < 0)) return { error: `${name}: lufsTolerance is in LU, 0 or more` };
    if (isNumber(p.lufsTolerance) && !isNumber(p.targetLufs)) return { error: `${name}: lufsTolerance goes with a targetLufs` };
    if (!optionalNumber(p.maxTruePeak) || (isNumber(p.maxTruePeak) && (p.maxTruePeak < -70 || p.maxTruePeak > 6))) {
      return { error: `${name}: maxTruePeak is in dBTP (e.g. -1), -70 to 6` };
    }
    if (p.audioFormats !== undefined && p.audioFormats !== null && !formatsOf(p.audioFormats)) {
      return { error: `${name}: audioFormats is a list of MIME types (audio/wav, audio/ogg...)` };
    }
    if (p.sampleRates !== undefined && p.sampleRates !== null
      && (!Array.isArray(p.sampleRates) || !p.sampleRates.every((r: unknown) => isCount(r) && (r as number) > 0))) {
      return { error: `${name}: sampleRates is a list of rates in Hz (44100, 48000...)` };
    }
    profiles.push({
      id, name, kind: 'audio',
      ...(isNumber(p.targetLufs) ? { targetLufs: p.targetLufs, lufsTolerance: isNumber(p.lufsTolerance) ? p.lufsTolerance : 1 } : {}),
      ...(isNumber(p.maxTruePeak) ? { maxTruePeak: p.maxTruePeak } : {}),
      ...(Array.isArray(p.audioFormats) ? { audioFormats: p.audioFormats.map((f: string) => f.trim().toLowerCase()) } : {}),
      ...(Array.isArray(p.sampleRates) ? { sampleRates: [...new Set<number>(p.sampleRates)] } : {}),
    });
  }
  const kindOf = (id: string) => profiles.find(p => p.id === id)?.kind ?? 'model';
  const defaultProfileId = body.defaultProfileId ?? null;
  if (defaultProfileId !== null && (!profiles.some(p => p.id === defaultProfileId) || kindOf(defaultProfileId) !== 'model')) {
    return { error: 'defaultProfileId is one of the 3D profiles' };
  }
  const defaultAudioProfileId = body.defaultAudioProfileId ?? null;
  if (defaultAudioProfileId !== null && (!profiles.some(p => p.id === defaultAudioProfileId) || kindOf(defaultAudioProfileId) !== 'audio')) {
    return { error: 'defaultAudioProfileId is one of the audio profiles' };
  }
  return { profiles, defaultProfileId, defaultAudioProfileId };
}

export const profileKind = (profile: BudgetProfile): MeasuredKind => profile.kind ?? 'model';

/** The profile an asset of a kind is checked against: the one it chose (of its kind), or the project's default for it. */
export function profileFor(budgets: AssetBudgets, chosen: string | null | undefined, kind: MeasuredKind = 'model'): BudgetProfile | null {
  const ofKind = budgets.profiles.filter(p => profileKind(p) === kind);
  const fallback = kind === 'audio' ? budgets.defaultAudioProfileId : budgets.defaultProfileId;
  return ofKind.find(p => p.id === chosen) ?? ofKind.find(p => p.id === fallback) ?? null;
}

/** What measurements have over a profile's limits. */
export function exceededBy(m: Measurements, profile: BudgetProfile | null): Exceeded[] {
  if (!profile) return [];
  if (m.kind === 'audio') return audioExceeded(m, profile);
  const over: Exceeded[] = [];
  const count = (metric: Exceeded['metric'], limit: number | undefined, value: number) => {
    if (limit !== undefined && value > limit) over.push({ metric, limit, value });
  };
  count('triangles', profile.maxTriangles, m.triangles);
  count('materials', profile.maxMaterials, m.materials);
  count('textures', profile.maxTextures, m.textures.length);
  count('animations', profile.maxAnimations, m.animations.length);
  for (const t of m.textures) {
    const side = Math.max(t.width, t.height);
    if (profile.maxTextureSize !== undefined && side > profile.maxTextureSize) {
      over.push({ metric: 'textureSize', limit: profile.maxTextureSize, value: side, texture: t.name });
    }
    if (profile.textureFormats && t.format && !profile.textureFormats.includes(t.format)) {
      over.push({ metric: 'textureFormat', limit: profile.textureFormats, value: t.format, texture: t.name });
    }
  }
  return over;
}

function audioExceeded(m: AudioMeasurements, profile: BudgetProfile): Exceeded[] {
  if (profileKind(profile) !== 'audio') return [];
  const over: Exceeded[] = [];
  if (profile.targetLufs !== undefined && m.integratedLufs !== null) {
    const tolerance = profile.lufsTolerance ?? 0;
    if (Math.abs(m.integratedLufs - profile.targetLufs) > tolerance + 1e-9) {
      over.push({ metric: 'loudness', limit: profile.targetLufs, tolerance, value: m.integratedLufs });
    }
  }
  if (profile.maxTruePeak !== undefined && m.truePeak !== null && m.truePeak > profile.maxTruePeak) {
    over.push({ metric: 'truePeak', limit: profile.maxTruePeak, value: m.truePeak });
  }
  if (profile.audioFormats && m.format && !profile.audioFormats.includes(m.format)) {
    over.push({ metric: 'audioFormat', limit: profile.audioFormats, value: m.format });
  }
  if (profile.sampleRates && !profile.sampleRates.includes(m.sampleRate)) {
    over.push({ metric: 'sampleRate', limit: profile.sampleRates, value: m.sampleRate });
  }
  return over;
}

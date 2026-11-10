import crypto from 'crypto';

// What a 3D asset's version measures (triangles, materials, textures, animations), and the
// project's budgets it's checked against. StreamBy measures nothing itself: whoever opens the
// version measures it (the inspector in the UI, with three.js; later a worker or a local tool)
// and sends the measurements, which are checked here and kept with the version.

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

export interface Measurements {
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

/** One kind of piece's budget: the most it may have of each (a limit not set isn't checked). */
export interface BudgetProfile {
  id: string;
  name: string;
  maxTriangles?: number;
  maxMaterials?: number;
  maxTextures?: number;
  // The longest side a texture may have, in pixels.
  maxTextureSize?: number;
  // The texture formats it may use (MIME types); any if not set.
  textureFormats?: string[];
  maxAnimations?: number;
}

export interface AssetBudgets {
  profiles: BudgetProfile[];
  // The profile an asset that chose none is checked against; none if null.
  defaultProfileId: string | null;
}

/** What a version has over its budget. */
export interface Exceeded {
  metric: 'triangles' | 'materials' | 'textures' | 'textureSize' | 'textureFormat' | 'animations';
  limit: number | string[];
  value: number | string;
  // The texture it's about, for a texture's size or format.
  texture?: string | null;
}

export const EMPTY_BUDGETS: AssetBudgets = { profiles: [], defaultProfileId: null };

const MAX_ITEMS = 1000;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isLimit = (v: unknown) => v === undefined || v === null || isCount(v);
const nameOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

type Checked<T> = T | { error: string };

/** Measurements as sent, checked (counts are whole numbers, at most 1000 textures/animations). */
export function checkMeasurements(body: any, measuredBy: string): Checked<Measurements> {
  if (!body || typeof body !== 'object') return { error: 'The measurements are an object' };
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

/** A project's budgets as sent, checked: each profile named, its limits whole numbers. */
export function checkBudgets(body: any): Checked<AssetBudgets> {
  if (!body || !Array.isArray(body.profiles)) return { error: 'The budgets are { profiles: [...], defaultProfileId }' };
  if (body.profiles.length > 100) return { error: 'At most 100 profiles' };
  const profiles: BudgetProfile[] = [];
  for (const p of body.profiles) {
    const name = nameOf(p?.name);
    if (!name) return { error: 'Each profile has a name' };
    for (const key of ['maxTriangles', 'maxMaterials', 'maxTextures', 'maxTextureSize', 'maxAnimations'] as const) {
      if (!isLimit(p[key])) return { error: `${name}: ${key} is a whole number, 0 or more` };
    }
    if (p.textureFormats !== undefined && p.textureFormats !== null
      && (!Array.isArray(p.textureFormats) || !p.textureFormats.every((f: unknown) => typeof f === 'string' && f.trim()))) {
      return { error: `${name}: textureFormats is a list of MIME types (image/png, image/ktx2...)` };
    }
    const id = typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID();
    if (profiles.some(q => q.id === id)) return { error: `Two profiles have the id ${id}` };
    if (profiles.some(q => q.name.toLowerCase() === name.toLowerCase())) return { error: `Two profiles are named ${name}` };
    const limits = Object.fromEntries((['maxTriangles', 'maxMaterials', 'maxTextures', 'maxTextureSize', 'maxAnimations'] as const)
      .filter(k => isCount(p[k])).map(k => [k, p[k]]));
    profiles.push({
      id, name, ...limits,
      ...(Array.isArray(p.textureFormats) ? { textureFormats: p.textureFormats.map((f: string) => f.trim().toLowerCase()) } : {}),
    });
  }
  const defaultProfileId = body.defaultProfileId ?? null;
  if (defaultProfileId !== null && !profiles.some(p => p.id === defaultProfileId)) return { error: 'defaultProfileId is one of the profiles' };
  return { profiles, defaultProfileId };
}

/** The profile an asset is checked against: the one it chose, or the project's default. */
export function profileFor(budgets: AssetBudgets, chosen: string | null | undefined): BudgetProfile | null {
  return budgets.profiles.find(p => p.id === chosen) ?? budgets.profiles.find(p => p.id === budgets.defaultProfileId) ?? null;
}

/** What measurements have over a profile's limits. */
export function exceededBy(m: Measurements, profile: BudgetProfile | null): Exceeded[] {
  if (!profile) return [];
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

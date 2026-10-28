import { nosqlDb } from '../utils/nosqlDb';
import { activeMemberOf } from '../utils/auth';
import { emitToUser } from './wsHub';

// An asset's license metadata: where it was taken from, who made it, and under what license.
// Kept in the `asset_rights` collection, one record per asset (for all its versions), the
// only place it lives: a credits sheet reads it from here, and writes to here.

export const LICENSE_TYPES = [
  'CC BY', 'CC BY-SA', 'CC BY-ND', 'CC BY-NC', 'CC BY-NC-SA', 'CC BY-NC-ND', 'CC0', 'Free Standard', 'Standard', 'Editorial',
] as const;
export type LicenseType = typeof LICENSE_TYPES[number];

export const RIGHTS_FIELDS = ['sourceUrl', 'creatorName', 'creatorUrl', 'licenseType', 'comments'] as const;
type RightsField = typeof RIGHTS_FIELDS[number];
const URL_FIELDS: RightsField[] = ['sourceUrl', 'creatorUrl'];
const MAX_TEXT = 2000;

export interface AssetRights {
  assetId: string;
  projectId: string;
  sourceUrl: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  licenseType: LicenseType | null;
  comments: string | null;
  updatedBy?: string;
  updatedAt?: Date;
}

export type RightsValues = Partial<Pick<AssetRights, RightsField>>;

const isLicense = (value: unknown): value is LicenseType => (LICENSE_TYPES as readonly unknown[]).includes(value);
const isUrl = (value: string) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

/**
 * The fields given of an asset's license metadata, checked: text (a link, an http(s) URL) and a
 * license from the list. A field given empty or null is cleared.
 */
export function checkRights(body: any): { values: RightsValues } | { error: string } {
  const values: RightsValues = {};
  for (const field of RIGHTS_FIELDS) {
    const raw = body?.[field];
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== 'string') return { error: `${field} must be text` };
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) { values[field] = null; continue; }
    if (value.length > MAX_TEXT) return { error: `${field} has at most ${MAX_TEXT} characters` };
    if (field === 'licenseType') {
      if (!isLicense(value)) return { error: `licenseType is one of: ${LICENSE_TYPES.join(', ')}` };
      values.licenseType = value;
    } else if (URL_FIELDS.includes(field) && !isUrl(value)) {
      return { error: `${field} must be an http(s) URL` };
    } else {
      (values as Record<string, string>)[field] = value;
    }
  }
  return { values };
}

/** The license metadata given as query params (an upload's), checked; null if none given. */
export function rightsFromQuery(query: Record<string, unknown>): { values: RightsValues } | { error: string } | null {
  const given = Object.fromEntries(RIGHTS_FIELDS.filter(f => typeof query[f] === 'string').map(f => [f, query[f]]));
  return Object.keys(given).length ? checkRights(given) : null;
}

const collection = () => nosqlDb()?.collection('asset_rights') ?? null;

// A record as it's answered: only the fields it has now (a license off the list reads as none).
const readRights = (record: any): AssetRights | null => record && {
  assetId: record.assetId,
  projectId: record.projectId,
  sourceUrl: record.sourceUrl ?? null,
  creatorName: record.creatorName ?? null,
  creatorUrl: record.creatorUrl ?? null,
  licenseType: isLicense(record.licenseType) ? record.licenseType : null,
  comments: record.comments ?? null,
  ...(record.updatedBy ? { updatedBy: record.updatedBy } : {}),
  ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
};

export async function getRights(projectId: string, assetId: string): Promise<AssetRights | null> {
  const col = collection();
  return col ? readRights(await col.findOne({ projectId, assetId })) : null;
}

/** Several assets' license metadata, by asset id (those with none are missing). */
export async function getRightsOf(projectId: string, assetIds: string[]): Promise<Map<string, AssetRights>> {
  const col = collection();
  if (!col || !assetIds.length) return new Map();
  const records = await col.find({ projectId, assetId: { $in: assetIds } }).toArray();
  return new Map(records.map(r => [r.assetId, readRights(r)!]));
}

// What changed in a project's assets' license metadata, to whoever is in it now: the credits
// sheets they have open read their rows again.
export function broadcastRights(project: any, data: { action: 'saved' | 'deleted'; assetIds: string[]; rights?: AssetRights }) {
  const projectId = String(project._id ?? project.id);
  for (const member of project.members ?? []) {
    if (activeMemberOf(project, member.userId)) emitToUser(member.userId, { type: 'assetRightsEvent', data: { projectId, ...data } });
  }
}

/** Sets the fields given of an asset's license metadata (checked already), and tells the project. */
export async function saveRights(project: any, assetId: string, values: RightsValues, userId: string): Promise<AssetRights> {
  const col = collection();
  if (!col) throw new Error('Database not available');
  const projectId = String(project._id ?? project.id);
  // The fields an earlier record had that this one doesn't (holder, territory...) go.
  const $unset = { rightsHolder: '', licenseUrl: '', territory: '', expiresAt: '', usageRestrictions: '', notes: '' };
  await col.updateOne(
    { projectId, assetId },
    { $set: { assetId, projectId, ...values, updatedBy: userId, updatedAt: new Date() }, $unset },
    { upsert: true },
  );
  const rights = (await getRights(projectId, assetId))!;
  broadcastRights(project, { action: 'saved', assetIds: [assetId], rights });
  return rights;
}

/** An asset's license metadata, gone with it (or, without an asset, a whole project's). */
export async function deleteRightsOf(projectId: string, assetId?: string): Promise<void> {
  const col = collection();
  if (!col || !projectId) return;
  await col.deleteMany(assetId ? { projectId, assetId } : { projectId });
}

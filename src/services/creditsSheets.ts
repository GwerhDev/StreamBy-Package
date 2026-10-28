import { nosqlDb } from '../utils/nosqlDb';
import { ProjectDocument } from '../types';
import { AssetRights, getRightsOf, LicenseType } from './rights';

// A credits sheet: a project document (kind 'credits') that a Credits sheet node of the
// workflow made, listing the assets fed to it with their license metadata. It keeps only what
// feeds it, never a copy of the metadata: assets and Storage folders picked on it (its content),
// and the Ingest nodes connected to its node (the asset each imports). Its rows are made each
// time it's read, from each asset's metadata, so every sheet shows the same, current, values.

export const CREDITS_SHEET_NODE = 'creditsSheetNode';

export interface SheetSources {
  assetIds: string[];
  folderIds: string[];
}

// What a sheet needs of each asset to credit it.
const REQUIRED = ['creatorName', 'sourceUrl', 'licenseType'] as const;
type Required = typeof REQUIRED[number];

export type RowSource = 'asset' | 'folder' | 'ingest';

export interface SheetRow {
  assetId: string;
  name: string;
  category: string | null;
  sourceUrl: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  licenseType: LicenseType | null;
  comments: string | null;
  // What it lacks of what crediting it needs: its row is marked while any is missing.
  missing: Required[];
  // How it got into the sheet: picked, in a folder picked, or imported by an Ingest connected.
  from: RowSource[];
}

export type SheetStatus = 'complete' | 'incomplete';

export interface CreditsSheet {
  document: ProjectDocument;
  sources: SheetSources;
  rows: SheetRow[];
  // Complete when it has an asset and none lacks anything.
  status: SheetStatus;
}

const ids = (value: unknown) =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()))] : null;

/** A sheet's content as it's saved: its sources, as JSON. */
export function checkSheetContent(value: unknown): string | { error: string } {
  if (value === undefined || value === '') return JSON.stringify({ assetIds: [], folderIds: [] });
  let parsed: any;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { return { error: 'A credits sheet\'s content is its sources, as JSON: { "assetIds": [...], "folderIds": [...] }' }; }
  const assetIds = ids(parsed?.assetIds ?? []);
  const folderIds = ids(parsed?.folderIds ?? []);
  if (!assetIds || !folderIds) return { error: 'assetIds and folderIds are lists of ids' };
  return JSON.stringify({ assetIds, folderIds });
}

export function sheetSources(document: Pick<ProjectDocument, 'content'>): SheetSources {
  try {
    const parsed = JSON.parse(document.content || '{}');
    return { assetIds: ids(parsed.assetIds) ?? [], folderIds: ids(parsed.folderIds) ?? [] };
  } catch {
    return { assetIds: [], folderIds: [] };
  }
}

/** The assets imported by the Ingest nodes connected (either way) to the sheet's node. */
export function ingestAssetsOf(workflow: any, documentId: string): string[] {
  const nodes: any[] = Array.isArray(workflow?.nodeSchema?.nodes) ? workflow.nodeSchema.nodes : [];
  const edges: any[] = Array.isArray(workflow?.nodeSchema?.edges) ? workflow.nodeSchema.edges : [];
  const sheetNodes = new Set(nodes.filter(n => n?.type === CREDITS_SHEET_NODE && n.data?.documentId === documentId).map(n => n.id));
  const byId = new Map(nodes.map(n => [n?.id, n]));
  const found: string[] = [];
  for (const edge of edges) {
    const other = sheetNodes.has(edge?.target) ? edge.source : sheetNodes.has(edge?.source) ? edge.target : null;
    const node = other != null ? byId.get(other) : null;
    if (node?.type === 'ingestNode' && typeof node.data?.fileId === 'string' && node.data.fileId) found.push(node.data.fileId);
  }
  return [...new Set(found)];
}

// The folders given and every folder inside them.
async function withSubfolders(db: any, projectId: string, folderIds: string[]): Promise<string[]> {
  if (!folderIds.length) return [];
  const all: any[] = await db.collection('storage_folders').find({ projectId }).toArray();
  const children = new Map<string, string[]>();
  for (const f of all) {
    if (f.parentId) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.folderId]);
  }
  const found = new Set<string>();
  const queue = folderIds.filter(id => all.some(f => f.folderId === id));
  while (queue.length) {
    const id = queue.shift()!;
    if (found.has(id)) continue;
    found.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return [...found];
}

const missingOf = (rights: AssetRights | undefined): Required[] => REQUIRED.filter(field => !rights?.[field]);

/** A sheet as it reads now: its rows, from its sources and its assets' metadata, and its status. */
export async function readSheet(project: any, document: ProjectDocument): Promise<CreditsSheet> {
  const projectId = String(project._id ?? project.id);
  const sources = sheetSources(document);
  const db = nosqlDb();
  const order: { assetId: string; from: RowSource }[] = sources.assetIds.map(assetId => ({ assetId, from: 'asset' as const }));
  let files: any[] = [];
  if (db) {
    const folders = await withSubfolders(db, projectId, sources.folderIds);
    if (folders.length) {
      const inFolders: any[] = await db.collection('storage_files').find({ projectId, folderId: { $in: folders } }).toArray();
      order.push(...inFolders.map(f => ({ assetId: f.fileId, from: 'folder' as const })));
    }
    order.push(...ingestAssetsOf(project.workflow, document.id).map(assetId => ({ assetId, from: 'ingest' as const })));
    const wanted = [...new Set(order.map(o => o.assetId))];
    files = wanted.length ? await db.collection('storage_files').find({ projectId, fileId: { $in: wanted } }).toArray() : [];
  }
  // An asset deleted is no longer in Storage: it leaves the sheet.
  const fileOf = new Map(files.map(f => [f.fileId, f]));
  const rights = await getRightsOf(projectId, [...fileOf.keys()]);

  const rows = new Map<string, SheetRow>();
  for (const { assetId, from } of order) {
    const file = fileOf.get(assetId);
    if (!file) continue;
    const row = rows.get(assetId);
    if (row) { if (!row.from.includes(from)) row.from.push(from); continue; }
    const r = rights.get(assetId);
    rows.set(assetId, {
      assetId,
      name: file.displayName ?? assetId,
      category: file.category ?? null,
      sourceUrl: r?.sourceUrl ?? null,
      creatorName: r?.creatorName ?? null,
      creatorUrl: r?.creatorUrl ?? null,
      licenseType: r?.licenseType ?? null,
      comments: r?.comments ?? null,
      missing: missingOf(r),
      from: [from],
    });
  }
  const list = [...rows.values()];
  return { document, sources, rows: list, status: list.length && list.every(r => !r.missing.length) ? 'complete' : 'incomplete' };
}

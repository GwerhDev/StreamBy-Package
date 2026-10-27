import type { ApiTokenPermission, ProjectPermission, AccountPermission } from '../services/apiTokenPermissions';
import { Request } from 'express';
import type { WebSocketServer } from 'ws';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageProviderType = 's3' | 'gcs' | 'r2' | 'azure';
export type StorageConnectionType = 's3' | 'gcs' | 'r2' | 'azure';

export interface StorageConnection {
  id: string;
  name: string;
  type: StorageConnectionType;
  encryptedCredential?: string;
  projectId: string;
  createdAt: Date;
  description?: string;
  isBuiltin?: boolean;
  integrationId?: string;
  source?: 'builtin' | 'integration' | 'manual';
  available?: boolean;
}

export type StorageProvider = {
  id: string;
  type: StorageProviderType;
  config: S3Config;
};

export interface StorageFileInfo {
  key: string;
  name: string;
  size: number;
  url: string;
  contentType: string;
  lastModified: string;
  category: string;
}

export interface StorageAdapter {
  listFiles(projectId: string): Promise<any[]>;
  deleteProjectImage: (projectId: string) => Promise<any>;
  deleteProjectDirectory: (projectId: string) => Promise<any>;
  getPresignedUrl?: (contentType: string, projectId: string) => Promise<any>;
  getPresignedProjectImageUrl?: (projectId: string) => Promise<any>;
  // expiresIn: seconds the URL works (the adapter's default if not given).
  getPresignedUploadUrl?: (key: string, contentType: string, expiresIn?: number) => Promise<string>;
  listFilesByCategory?: (projectId: string, category: string) => Promise<StorageFileInfo[]>;
  deleteFile?: (key: string) => Promise<void>;
  // Copies a stored file to another key (to archive an asset's version before replacing it).
  copyFile?: (from: string, to: string) => Promise<void>;
  // downloadName: the file is downloaded (not shown inline) with this name.
  getPresignedGetUrl?: (key: string, expiresIn?: number, downloadName?: string) => Promise<string>;
}

export interface FieldDefinition {
  name: string;
  type: string;
  label: string;
  required?: boolean;
  // Add any other properties that a field definition might have
}

export interface ProjectInfo {
  _id?: string;
  id: string;
  dbType?: DatabaseType;
  name: string;
  image?: string;
  public?: boolean;
  members?: {
    role: 'viewer' | 'editor' | 'admin';
    userId: string;
    archived?: boolean;
    // 'pending' until the invitation (or the request to join) is accepted.
    status?: 'active' | 'pending';
  }[];
  description?: string;
  exports?: {
    id: string;
    collectionName: string;
  }[];
  settings?: {
    allowUpload?: boolean;
    allowSharing?: boolean;
  };
  connections?: Connection[];
  dbConnections?: DbConnection[];
  storageConnections?: StorageConnection[];
  integrationConnections?: IntegrationConnection[];
  pipelines?: PipelineRef[];
  // Set once by backfillBuiltinConnections after seeding built-in dbConnections/
  // storageConnections for a pre-BYOC project — guards against re-seeding a builtin an
  // admin has since disconnected on purpose.
  builtinBackfilledAt?: Date;
  workflow?: Workflow;
}

// Where a given node type's execution output actually lands. Used to validate, at
// execution time, that a node has an explicit connectionId/storageConnectionId of its
// own — never enforced at build/save time, and never resolved via any project-level
// fallback (a project can have many database/storage/API providers connected at once).
export type NodePersistence = 'database' | 'storage' | 'both' | 'none';

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: string;
  projectId: string;
  nodeSchema: NodeSchema | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ConnectionMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Connection {
  id: string;
  name: string;
  apiUrl: string;
  method: ConnectionMethod;
  projectId: string;
  createdAt: Date;
  prefix?: string;
  description?: string;
  encryptedCredential?: string;
}

export interface ProjectListInfo {
  id: string;
  dbType?: DatabaseType;
  name: string;
  image?: string;
  archived: boolean;
}

export type DatabaseType = 'sql' | 'nosql';

export interface DatabaseCredential {
  id: string;
  type: DatabaseType;
  connectionString?: string;
  main?: boolean;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  // Full callback URL the provider redirects back to, e.g.
  // 'https://api.nhexa.cl/streamby/user/integrations/oauth/jira/callback'. Required because
  // StreamBy-Package is mounted at a host-chosen path prefix (Nhexa-API mounts at
  // '/streamby') and has no reliable way to reconstruct its own public URL from req alone
  // (proxies, custom domains) — the host must supply it explicitly, same reasoning as why
  // canUseBuiltin is host-injected rather than inferred.
  redirectUri: string;
  // Where the callback finally sends the browser once token exchange finishes — a
  // StreamBy-UI route. The backend appends a query param describing the outcome —
  // `?connected=jira` on success, `?oauthError=<reason>` on failure — so the frontend can
  // show a toast/status without needing its own polling or postMessage handshake.
  successRedirectUrl: string;
  failureRedirectUrl: string;
}

export interface StreamByConfig {
  storageProviders: StorageProvider[];
  authProvider: AuthProvider;
  databases?: DatabaseCredential[];
  adapter?: StorageAdapter;
  // The key stored credentials are encrypted with (64 hex characters), and the previous ones
  // they may still be in: rotating is putting the new key here and the old one in
  // encryptPreviousKeys -- what's stored is re-encrypted with the new one at startup.
  encrypt?: string;
  encryptPreviousKeys?: string[];
  // The MCP server (POST /mcp), for agents with an API token.
  mcp?: {
    // Requests per API token: at most `requests` in any `windowMs` (default 120 a minute).
    rateLimit?: { requests: number; windowMs: number };
    // Where its tools reach the REST API (this router's mount). Default: this same process,
    // at the request's local port and mount path.
    apiBaseUrl?: string;
    // Seconds the signed storage URLs given to an API token work: to upload (default 15
    // minutes) and to download (default 5 minutes).
    signedUrlTtl?: { upload?: number; download?: number };
  };
  // StreamBy as an OAuth 2 protected resource (RFC 9728): what it tells a client (an MCP client
  // such as claude.ai) that comes without a token, so it can sign in. Validating the tokens is
  // the host's authProvider's (see services/oauthTokens).
  oauth?: OAuthResourceConfig;
  websocket?: {
    server: WebSocketServer;
  };
  // Gates access to a built-in database/storage provider — implemented by whoever mounts
  // the package (e.g. Nhexa-API checking user_subscriptions). Absent = allow (default,
  // preserves pre-BYOC behavior for deploys that don't implement subscription gating).
  canUseBuiltin?: (auth: Auth, builtinId: string, kind: 'database' | 'storage' | 'worker') => boolean | Promise<boolean>;
  // Processing workers offered to every project (gated, like the other built-ins, by
  // canUseBuiltin with kind 'worker').
  workers?: WorkerConfig[];
  workerOptions?: {
    // The URL workers call back to: this router's public URL (e.g.
    // 'https://api.example.com/streamby'). Default: the URL a job was asked for at.
    callbackBaseUrl?: string;
    // How many times a job is sent to its worker before it fails (default 3).
    maxAttempts?: number;
    // How often each instance looks for jobs to send again (ms; default 30 seconds; 0: never).
    sweepIntervalMs?: number;
    // Lets a project's worker be on a local or private address, or plain http (development).
    allowLocalEndpoints?: boolean;
  };
  // Registers this deploy as an OAuth CLIENT of Jira/Google (StreamBy is the client, NOT
  // the provider). Absent per-provider = that provider's OAuth start/callback routes
  // respond 503 ("not configured"), matching canUseBuiltin's "absent = safe default"
  // convention rather than crashing at boot.
  oauthProviders?: {
    jira?: OAuthClientConfig;
    google?: OAuthClientConfig;
  };
}

export interface Notification {
  _id?: string;
  userId: string;
  appId?: string;
  type: string;
  message: string;
  data?: any;
  callback?: string;
  read: boolean;
  readAt?: Date;
  createdAt: Date;
}

export interface Auth {
  userId: string;
  username: string;

  role: 'viewer' | 'editor' | 'admin';
  // Set when the request was made with an API token (see services/apiTokens): it reaches only
  // what the token's permissions and projects do -- a user's token never more than its owner.
  // An OAuth access token's request has one too: the permissions its scopes grant.
  apiToken?: ApiTokenScope;
  // Set when the request was made with an OAuth access token: the app the user let act for them.
  oauth?: OAuthClientInfo;
}

export interface OAuthClientInfo {
  clientId: string;
  // How the host knows it (e.g. the name the user approved), when it does.
  clientName?: string;
}

export interface OAuthResourceConfig {
  // The authorization server that issues the tokens (its issuer identifier).
  issuer: string;
  // This resource's identifier, as clients ask tokens for it (RFC 8707), e.g.
  // 'https://api.example.com/streamby/mcp'.
  resource: string;
  // Where its metadata is published, announced in WWW-Authenticate. Default: RFC 9728's place
  // for `resource` (<origin>/.well-known/oauth-protected-resource<path>), at the host's root,
  // which the host serves (see protectedResourceMetadata). This router also answers it at its
  // own GET /.well-known/oauth-protected-resource.
  resourceMetadataUrl?: string;
  // The name clients show it by (default 'StreamBy').
  resourceName?: string;
}

export type { ApiTokenPermission, ProjectPermission, AccountPermission };

// 'user': a user's, acting as them. 'project': a project's, acting on it alone, whoever made it.
export type ApiTokenKind = 'user' | 'project';

export interface ApiTokenScope {
  tokenId: string;
  kind: ApiTokenKind;
  permissions: ApiTokenPermission[];
  // The projects it reaches, or '*': every project its owner is a member of. A project's token
  // reaches its project only.
  projectIds: string[] | '*';
}

export type AuthProvider = (req: Request) => Promise<Auth>;

export type UserPlan = 'freemium' | 'subscriber' | 'admin';

export interface UserSubscription {
  id: string;
  user_id: string;
  plan: UserPlan;
  created_at: Date;
  updated_at: Date;
}

export type ExternalDbType = 'postgresql' | 'mongodb';

export interface DbConnection {
  id: string;
  name: string;
  dbType: ExternalDbType;
  encryptedCredential?: string;
  projectId: string;
  createdAt: Date;
  description?: string;
  isBuiltin?: boolean;
  integrationId?: string;
  source?: 'builtin' | 'integration' | 'manual';
}

// A project-level connection to an account-level SERVICE integration (Claude/Jira/Google).
// Unlike DbConnection/StorageConnection, this has no `isBuiltin`/`source: 'builtin'` variant
// — there is no such thing as a built-in service integration (config.databases/
// storageProviders have no service equivalent), so source is always 'integration'. Modeled
// as a literal type (not a union with 'manual'/'builtin') to make that structurally clear
// and to keep classifyIntegrationId's return type honest.
export interface IntegrationConnection {
  id: string;
  name: string;
  provider: ServiceProviderType;
  projectId: string;
  createdAt: Date;
  description?: string;
  integrationId: string;
  source: 'integration';
}

export type IntegrationKind = 'database' | 'storage' | 'service';

export type ServiceProviderType = 'claude' | 'jira' | 'google';

// A user-registered (BYOC) database/storage credential, or a third-party service account
// link (Claude/Jira/Google) — always the user's own, never a copy of a built-in. Lives in
// the main db only (see createRouter.ts's mainDb block).
export interface UserIntegration {
  id: string;
  userId: string;
  kind: IntegrationKind;
  provider: ExternalDbType | StorageProviderType | ServiceProviderType;
  name: string;
  description?: string;
  // Non-OAuth credential (db/storage connection strings, Claude API key). Absent for
  // jira/google, which use the three fields below instead.
  encryptedCredential?: string;
  // OAuth-only fields (jira/google). Each encrypted independently via the existing
  // single-string encrypt()/decrypt() primitives — no new crypto, just three calls
  // instead of one. Absent for database/storage/claude integrations.
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  tokenExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ColumnDefinition {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface CreateTableSchema {
  tableName: string;
  columns: ColumnDefinition[];
}

export interface NodeSchema {
  nodes: any[];
  edges: any[];
}

// A Pipeline is a sub-workflow for a specific sub-process; a project has many.
// The `pipelines` collection is the source of truth; ProjectInfo.pipelines holds
// lightweight refs kept in sync on create/update/delete.
export interface Pipeline {
  _id?: string;
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  order: number;
  nodeSchema: NodeSchema | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineRef {
  id: string;
  name: string;
  order: number;
}

export interface Export {
  _id?: string;
  id: string;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  // legacy fields — kept for backward compatibility
  type?: 'json' | 'externalApi';
  fields?: FieldDefinition[];
  jsonData?: any;
  apiUrl?: string;
  encryptedCredential?: string;
  prefix?: string;
  // current fields
  private?: boolean;
  allowedOrigin?: string[];
  nodeSchema?: NodeSchema;
  useConnections?: boolean;
  useCredentials?: boolean;
  storageDbId?: string;
  // Phase 4 deliverable fields
  deliverableType?: 'api' | 'video-stream' | 'game-build' | 'asset-bundle' | 'app-binary';
  deliverableVersion?: string;
  deliverableTargets?: DeliveryTarget[];
  publishedAt?: Date;
  publishedBy?: string;
  cdnUrl?: string;
}

export type DistributionTarget =
  | 'cdnPush'
  | 'hlsStream'
  | 'steam'
  | 'appStoreConnect'
  | 'googlePlay'
  | 'itchIo'
  | 'customWebhook';

export type DeliveryStatus = 'pending' | 'publishing' | 'published' | 'failed';

export interface DeliveryTarget {
  connectionId: string;
  target: DistributionTarget;
  channel?: string;
  publishedAt?: Date;
  publishedBy?: string;
  receipt?: Record<string, string>;
  status: DeliveryStatus;
}

export interface DistributionConnection {
  id: string;
  name: string;
  target: DistributionTarget;
  encryptedCredential?: string;
  projectId: string;
  config: Record<string, string>;
  createdAt: Date;
  description?: string;
}

export interface QcCheck {
  name: string;
  passed: boolean;
  value: string | number;
  threshold: string | number;
  message?: string;
}

export interface QcReportRecord {
  assetId: string;
  projectId: string;
  checks: QcCheck[];
  overallPassed: boolean;
  generatedAt: Date;
}

export type JobType =
  | 'ingest' | 'transcode' | 'caption' | 'thumbnail'
  | 'render' | 'format-convert' | 'lod'
  | 'distribute' | 'qc'
  | 'transcription' | 'upscale' | 'generate-asset'
  | 'process';

export type AiProvider = 'openai' | 'deepgram' | 'assemblyai' | 'stabilityai' | 'meshy' | 'elevenlabs' | 'custom';

export interface PipelineSuggestion {
  rationale: string;
  nodesToAdd: { type: string; label: string; position: { x: number; y: number } }[];
  edgesToAdd: { source: string; sourceHandle: string; target: string; targetHandle: string }[];
}

export type RenderFarmProvider = 'flamenco' | 'deadline' | 'rebusfarm' | 'sheepit' | 'custom';

export interface RenderFarmConnection {
  id: string;
  name: string;
  provider: RenderFarmProvider;
  apiUrl: string;
  encryptedCredential?: string;
  projectId: string;
  createdAt: Date;
  description?: string;
}

export interface LodLevel {
  level: number;
  ratio: number;
  storageFileId: string;
  polyCount?: number;
  fileSize?: number;
}

export interface LodManifestRecord {
  assetId: string;
  projectId: string;
  levels: LodLevel[];
  generatedAt: Date;
}

export interface AssetDependencyGraphRecord {
  rootAssetId: string;
  projectId: string;
  nodes: { assetId: string; type: string; resolved: boolean }[];
  edges: { from: string; to: string; relationship: string }[];
  resolvedAt: Date;
}

export type ReviewStatus = 'open' | 'approved' | 'rejected' | 'expired';
export type ReviewDecision = 'approve' | 'reject';

export interface ReviewApproval {
  userId: string;
  username: string;
  decision: ReviewDecision;
  comment?: string;
  at: Date;
}

export interface ReviewSessionRecord {
  id: string;
  projectId: string;
  assetId: string;
  assetVersionId: string;
  status: ReviewStatus;
  requiredApprovers: number;
  approvals: ReviewApproval[];
  deadline?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type AnnotationType = 'timecoded' | 'spatial' | 'region';

export interface AnnotationRecord {
  id: string;
  assetId: string;
  assetVersionId: string;
  projectId: string;
  authorId: string;
  authorUsername: string;
  type: AnnotationType;
  timecode?: string;
  position3d?: { x: number; y: number; z: number };
  regionRect?: { x: number; y: number; width: number; height: number };
  text: string;
  resolved: boolean;
  resolvedBy?: string;
  createdAt: Date;
}
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobRecord {
  jobId: string;
  jobType: JobType;
  userId: string;
  projectId: string;
  assetId?: string;
  status: JobStatus;
  stage: string;
  progress: number;
  payload: Record<string, any>;
  error?: string;
  createdAt: Date;
  updatedAt: Date;

  // ── A worker's job (jobType 'process'; see services/workerJobs) ──
  // The worker that processes it, what it asks of it, and the asset's version it reads.
  worker?: WorkerRef | null;
  kind?: string | null;
  profile?: Record<string, unknown> | null;
  versionId?: string | null;
  // Where its result goes: a new version of the asset, or a new asset derived from it.
  resultMode?: WorkerResultMode | null;
  attempts?: number;
  maxAttempts?: number;
  // When it may be sent (again) to the worker; until when the worker has it.
  nextAttemptAt?: Date | null;
  leaseUntil?: Date | null;
  // sha256 of the token the worker calls back with (never the token itself).
  callbackHash?: string | null;
  // The result's upload, while the worker sends it: its key and what it is.
  upload?: { storageKey: string; fileName: string; contentType: string } | null;
  // What the worker reported, and what was made of its result.
  report?: Record<string, unknown> | null;
  result?: { assetId: string; versionId: string; mode: WorkerResultMode } | null;
}

export type WorkerResultMode = 'version' | 'derived';
export type WorkerSource = 'builtin' | 'project';
export interface WorkerRef { source: WorkerSource; id: string; name: string }

/**
 * A processing worker a host offers every project (`StreamByConfig.workers`). StreamBy sends
 * it jobs (see the README's worker contract) and keeps what it makes.
 */
export interface WorkerConfig {
  id: string;
  name: string;
  // Where jobs are sent (POST), and the credential sent with them (`Authorization: Bearer`).
  endpoint: string;
  credential?: string;
  // What it does (e.g. 'gltf-optimize', 'lod'), and the asset categories it takes.
  kinds: string[];
  categories: StorageCategoryName[];
  // A kind it runs by itself on an asset of its categories marked as a deliverable.
  autoKind?: string | null;
  // How long it may take with a job before it's sent again (seconds; default an hour).
  timeoutSeconds?: number;
}

export type StorageCategoryName = 'images' | 'audios' | 'videos' | '3d-models';

export interface AssetMetadataRecord {
  assetId: string;
  projectId: string;
  duration?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  colorSpace?: string;
  codec?: string;
  bitrate?: number;
  channels?: number;
  sampleRate?: number;
  customTags: Record<string, string>;
  extractedAt: Date;
}

export interface AssetVersionRecord {
  versionId: string;
  assetId: string;
  projectId: string;
  version: number;
  label?: string;
  storageKey: string;
  size: number;
  createdBy: string;
  changeNote?: string;
  createdAt: Date;
}

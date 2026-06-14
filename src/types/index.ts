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
  credentialId: string;
  projectId: string;
  createdAt: Date;
  description?: string;
  isBuiltin?: boolean;
}

export type StorageProvider = {
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
  getPresignedUploadUrl?: (key: string, contentType: string) => Promise<string>;
  listFilesByCategory?: (projectId: string, category: string) => Promise<StorageFileInfo[]>;
  deleteFile?: (key: string) => Promise<void>;
  getPresignedGetUrl?: (key: string) => Promise<string>;
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
  credentials?: Credential[];
  apiConnections?: ApiConnection[];
  dbConnections?: DbConnection[];
  storageConnections?: StorageConnection[];
}

export interface Credential {
  id: string;
  key: string;
  encryptedValue: string;
}

export type ApiConnectionMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiConnection {
  id: string;
  name: string;
  apiUrl: string;
  method: ApiConnectionMethod;
  projectId: string;
  createdAt: Date;
  prefix?: string;
  description?: string;
  credentialId?: string;
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

export interface StreamByConfig {
  storageProviders: {
    type: StorageProviderType;
    config: S3Config;
  }[];
  authProvider: AuthProvider;
  databases?: DatabaseCredential[];
  adapter?: StorageAdapter;
  encrypt?: string;
  websocket?: {
    server: WebSocketServer;
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
  credentialId: string;
  projectId: string;
  createdAt: Date;
  description?: string;
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
  credentialId?: string;
  prefix?: string;
  // current fields
  private?: boolean;
  allowedOrigin?: string[];
  nodeSchema?: NodeSchema;
  useConnections?: boolean;
  useCredentials?: boolean;
  storageDbId?: string;
}

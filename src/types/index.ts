import { Request } from 'express';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageProviderType = 's3';

export type StorageProvider = {
  type: StorageProviderType;
  config: S3Config;
};

export interface StorageAdapter {
  listFiles(projectId: string): Promise<any[]>;
  deleteProjectImage: (projectId: string) => Promise<any>;
  deleteProjectDirectory: (projectId: string) => Promise<any>;
  getPresignedUrl?: (contentType: string, projectId: string) => Promise<any>;
  getPresignedProjectImageUrl?: (projectId: string) => Promise<any>;
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
  dbType: DatabaseType;
  name: string;
  image?: string;
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
}

export interface Credential {
  id: string;
  key: string;
  encryptedValue: string;
}

export interface ProjectListInfo {
  id: string;
  dbType: DatabaseType;
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
}

export interface Auth {
  userId: string;
  username: string;
  
  role: 'viewer' | 'editor' | 'admin';
}

export type AuthProvider = (req: Request) => Promise<Auth>;

export interface Export {
  _id?: string;
  id: string;
  collectionName: string;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  type: 'structured' | 'raw' | 'json' | 'externalApi';
  fields?: FieldDefinition[];
  jsonData?: any;
  private?: boolean;
  allowedOrigin?: string[]; // Changed to singular
  apiUrl?: string;
  credentialId?: string;
  prefix?: string;
}

import { Request } from 'express';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageProviderType = 's3';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

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

export interface ProjectInfo {
  id: string;
  name: string;
  image?: string;
  members?: {
    role: 'viewer' | 'editor' | 'admin';
    userId: string;
    archived?: boolean;
  }[];
  description?: string;
  rootFolders?: FolderNode[];
  settings?: {
    allowUpload?: boolean;
    allowSharing?: boolean;
  };
}

export interface ProjectListInfo {
  id: string;
  name: string;
  image?: string;
  archived: boolean;
}

export interface FolderNode {
  id: string;
  name: string;
  children?: FolderNode[];
}

export type DatabaseType = 'mongo';

export interface DatabaseCredential {
  dbType: DatabaseType;
  connectionString: string;
}

export interface StreamByConfig {
  storageProviders: {
    type: StorageProviderType;
    config: S3Config;
  }[];
  authProvider: AuthProvider;
  databases?: DatabaseCredential[];
  projectProvider?: ProjectProvider;
  adapter?: StorageAdapter;
}

export interface AuthContext {
  userId: string;
  username: string;
  projects: string[];
  role: 'viewer' | 'editor' | 'admin';
}

export type AuthProvider = (req: Request) => Promise<AuthContext>;

export interface ProjectProvider {
  getExport(projectId: string, exportName: string): Promise<any[]>;
  archive(projectId: string, userId: string): Promise<{ success: boolean, projects: ProjectInfo[] }>;
  unarchive(projectId: string, userId: string): Promise<{ success: boolean, projects: ProjectInfo[] }>;
  list(userId?: string): Promise<ProjectInfo[]>;
  getById(projectId: string): Promise<ProjectInfo>;
  delete(projectId: string): Promise<{ success: boolean }>;
  update(projectId: string, updates: Partial<Omit<ProjectInfo, 'id' | 'rootFolders'>>): Promise<ProjectInfo>;
  create(data: {
    name: string;
    image?: string;
    members?: {
      userId: string;
      role: 'viewer' | 'editor' | 'admin';
    }[];
    description?: string;
    allowUpload?: boolean;
    allowSharing?: boolean;
    rootFolders?: FolderNode[];
  }): Promise<ProjectInfo>;
}

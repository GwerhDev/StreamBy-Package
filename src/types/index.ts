import { Request } from 'express';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageProviderType = 's3';

export interface StorageAdapter {
  listFiles(projectId: string): Promise<any[]>;
  getPresignedUrl?: (filename: string, contentType: string, projectId: string) => Promise<any>;
}

export interface ProjectInfo {
  id: string;
  name: string;
  image?: string;
  description?: string;
  rootFolders?: FolderNode[];
  settings?: {
    allowUpload?: boolean;
    allowSharing?: boolean;
  };
}

export interface FolderNode {
  id: string;
  name: string;
  children?: FolderNode[];
}

export interface StreamByConfig {
  storageProvider: {
    type: StorageProviderType;
    config: S3Config;
  };
  authProvider: AuthProvider;
  projectProvider: ProjectProvider;
}

export interface AuthContext {
  userId: string;
  username: string;
  projects: string[];
  role: 'viewer' | 'editor' | 'admin';
}

export type AuthProvider = (req: Request) => Promise<AuthContext>;

export interface ProjectProvider {
  getById(projectId: string): Promise<ProjectInfo>;
  update(projectId: string, updates: Partial<Omit<ProjectInfo, 'id' | 'rootFolders'>>): Promise<ProjectInfo>;
  create(data: {
    name: string;
    image?: string;
    description?: string;
    allowUpload?: boolean;
    allowSharing?: boolean;
    rootFolders?: FolderNode[];
  }): Promise<ProjectInfo>;
}

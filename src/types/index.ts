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
  dbType: DatabaseType;
  name: string;
  image?: string;
  members?: {
    role: 'viewer' | 'editor' | 'admin';
    userId: string;
    archived?: boolean;
  }[];
  description?: string;
  folders?: FolderNode[]; // Cambiado de rootFolders a folders
  exports?: {
    id: string; // Cambiado de _id a id
    collectionName: string;
  }[];
  settings?: {
    allowUpload?: boolean;
    allowSharing?: boolean;
  };
}

export interface ProjectListInfo {
  id: string;
  dbType: DatabaseType;
  name: string;
  image?: string;
  archived: boolean;
}

export interface FolderNode {
  id: string;
  name: string;
  children?: FolderNode[];
}

export type DatabaseType = 'sql' | 'nosql';

export interface DatabaseCredential {
  dbType: DatabaseType;
  connectionString?: string; // connectionString ahora es opcional
}

export interface StreamByConfig {
  storageProviders: {
    type: StorageProviderType;
    config: S3Config;
  }[];
  authProvider: AuthProvider;
  databases?: DatabaseCredential[];
  exportProvider?: ExportProvider;
  projectProvider?: ProjectProvider;
  exportCollectionProvider?: ExportCollectionProvider; // Añadido
  adapter?: StorageAdapter;
}

export interface AuthContext {
  userId: string;
  username: string;
  projects: string[];
  role: 'viewer' | 'editor' | 'admin';
}

export type AuthProvider = (req: Request) => Promise<AuthContext>;

export interface Export {
  id: string;
  collectionName: string;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportProvider {
  getById(exportId: string): Promise<Export | null>; // Puede ser null
  create(data: {
    name: string;
    description?: string;
    collectionName: string;
    projectId: string;
  }): Promise<Export>;
}

export interface ProjectProvider {
  getExport(projectId: string, exportId: string): Promise<any | null>; // Puede ser null
  archive(projectId: string, userId: string): Promise<{ success: boolean, projects: ProjectListInfo[] }>; // Cambiado a ProjectListInfo[]
  unarchive(projectId: string, userId: string): Promise<{ success: boolean, projects: ProjectListInfo[] }>; // Cambiado a ProjectListInfo[]
  list(userId?: string): Promise<ProjectListInfo[]>; // Cambiado a ProjectListInfo[]
  getById(projectId: string, populateMembers?: boolean): Promise<ProjectInfo>;
  delete(projectId: string): Promise<{ success: boolean }>;
  update(projectId: string, updates: Partial<Omit<ProjectInfo, 'id' | 'folders'>>): Promise<ProjectInfo>; // Cambiado de rootFolders a folders
  create(data: {
    dbType: DatabaseType;
    name: string;
    image?: string;
    members?: {
      userId: string;
      role: 'viewer' | 'editor' | 'admin';
    }[];
    description?: string;
    allowUpload?: boolean;
    allowSharing?: boolean;
    folders?: FolderNode[]; // Cambiado de rootFolders a folders
  }): Promise<ProjectInfo>;
  addExportToProject(projectId: string, exportId: string): Promise<void>;
}

export interface ExportEntry {
  id: string;
  key: string;
  value: string;
  exportCollectionId: string;
}

export interface ExportCollectionProvider {
  getById(id: string): Promise<any | null>;
  create(data: {
    projectId: string;
    name: string;
    entries: Array<{ key: string; value: string }>;
  }): Promise<any>;
  update(id: string, data: {
    name?: string;
    entries?: Array<{ key: string; value: string }>;
  }): Promise<any>;
  delete(id: string): Promise<{ success: boolean }>;
}
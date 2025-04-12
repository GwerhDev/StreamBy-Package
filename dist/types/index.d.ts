import { Request } from 'express';
export interface S3Config {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
}
export type StorageProviderType = 's3';
export interface StorageAdapter {
    uploadFile(req: Request, projectId: string): Promise<any>;
    listFiles(projectId: string): Promise<any[]>;
}
export interface StreamByConfig {
    storageProvider: {
        type: StorageProviderType;
        config: S3Config;
    };
    authProvider: (req: Request) => Promise<{
        userId: string;
        projectId: string;
    }>;
}

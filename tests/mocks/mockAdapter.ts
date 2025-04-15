import { StorageAdapter } from '../../src/types';
import { Request } from 'express';

export const mockAdapter: StorageAdapter = {
  async listFiles(projectId: string) {
    return [
      { name: 'testfile.txt', key: `${projectId}/testfile.txt` },
    ];
  },

  async uploadFile(req: Request, projectId: string) {
    return {
      success: true,
      key: `${projectId}/uploaded.txt`,
    };
  },
};

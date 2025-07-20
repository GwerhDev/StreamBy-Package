import { Model } from 'mongoose';
import { ExportProvider } from '../types';

export function createMongooseExportProvider(ExportModel: Model<any>): ExportProvider {
  return {
    async getById(exportId: string): Promise<any> {
      return await ExportModel.findById(exportId).lean();
    },
    async create(data: {
      name: string;
      description?: string;
      collectionName: string;
      projectId: string;
    }): Promise<any> {
      return await ExportModel.create(data);
    }
  };
}

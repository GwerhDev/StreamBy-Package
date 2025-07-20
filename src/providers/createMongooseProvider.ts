import mongoose from 'mongoose';
import { StorageAdapter, ProjectProvider, ExportProvider, ExportCollectionProvider } from '../types';
import { initProjectModel } from '../mongoose_models/initProjectModel';
import { initExportModel } from '../mongoose_models/initExportModel';
import { createMongooseExportProvider } from './mongooseExportProvider';
import { createMongooseProjectProvider } from './mongooseProjectProvider';

export function createMongooseProvider(connectionString: string, adapter: StorageAdapter) {
  if (!connectionString) {
    console.warn('Connection string is not provided. Mongoose client will not be initialized.');
    return null;
  }

  const mongooseClient = mongoose.createConnection(connectionString, {
    dbName: undefined,
  });

  const ExportModel = initExportModel(mongooseClient);
  const ProjectModel = initProjectModel(mongooseClient);

  const exportProvider: ExportProvider = createMongooseExportProvider(ExportModel);
  const projectProvider: ProjectProvider = createMongooseProjectProvider(ProjectModel, ExportModel, adapter);

  // Mongoose does not have a direct equivalent for ExportCollectionProvider in the same way Prisma does.
  // If a Mongoose-based ExportCollectionProvider is needed, it would be implemented here.
  const exportCollectionProvider: ExportCollectionProvider | undefined = undefined;

  return {
    mongooseClient,
    exportProvider,
    projectProvider,
    exportCollectionProvider,
  };
}
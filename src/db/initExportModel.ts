import mongoose from 'mongoose';

export function initExportModel(connection: mongoose.Connection) {
  const exportSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    collectionName: { type: String, required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  }, {
    timestamps: true,
    collection: 'streamby_exports'
  });

  return connection.model('Export', exportSchema);
}

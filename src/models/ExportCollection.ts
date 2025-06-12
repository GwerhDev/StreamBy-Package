import mongoose from 'mongoose';

const ExportEntrySchema = new mongoose.Schema({}, { strict: false, _id: false });

const ExportCollectionSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  name: { type: String, required: true }, // e.g., "experience"
  entries: [ExportEntrySchema],
}, {
  timestamps: true,
});

ExportCollectionSchema.index({ projectId: 1, name: 1 }, { unique: true });

export function initExportCollectionModel(connection: mongoose.Connection) {
  return connection.model('ExportCollection', ExportCollectionSchema);
}

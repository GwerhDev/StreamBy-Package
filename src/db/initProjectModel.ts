import mongoose from 'mongoose';

export function initProjectModel(connection: mongoose.Connection) {
  const folderNodeSchema = new mongoose.Schema({
    id: String,
    name: String,
    children: [Object],
  }, { _id: false });

  const projectSchema = new mongoose.Schema({
    name: { type: String, required: true },
    image: { type: String },
    description: { type: String },
    rootFolders: [folderNodeSchema],
    allowUpload: { type: Boolean, default: true },
    allowSharing: { type: Boolean, default: false },
  }, {
    timestamps: true
  });

  return connection.model('Project', projectSchema);
}

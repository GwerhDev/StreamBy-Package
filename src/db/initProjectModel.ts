import mongoose from 'mongoose';

export function initProjectModel(connection: mongoose.Connection) {
  const folderNodeSchema = new mongoose.Schema({
    id: String,
    name: String,
    children: [Object],
  }, { _id: false });

  const projectSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    image: { type: String },
    rootFolders: [folderNodeSchema],
    allowUpload: { type: Boolean, default: true },
    allowSharing: { type: Boolean, default: false },
    members: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      role: { type: String, enum: ['viewer', 'editor', 'admin'], default: 'viewer' }
    }]
  }, {
    timestamps: true
  });

  return connection.model('Project', projectSchema);
}

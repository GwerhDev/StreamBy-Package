import mongoose from 'mongoose';

export function initProjectModel(connection: mongoose.Connection) {
  const folderNodeSchema = new mongoose.Schema({
    id: String,
    name: String,
    children: [Object],
  }, { _id: false });

  const memberSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ['viewer', 'editor', 'admin'], default: 'viewer' },
    archived: { type: Boolean, default: false }
  }, { _id: false });

  const projectSchema = new mongoose.Schema({
    dbType: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    image: { type: String },
    rootFolders: [folderNodeSchema],
    allowUpload: { type: Boolean, default: true },
    allowSharing: { type: Boolean, default: false },
    members: [memberSchema],
    exports: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Export' }]
  }, {
    timestamps: true,
    collection: 'streamby_projects'
  });

  return connection.model('Project', projectSchema);
}

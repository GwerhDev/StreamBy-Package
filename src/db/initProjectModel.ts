import { Connection, Schema, Model, Document } from 'mongoose';

export interface FolderNode {
  name: string;
  children?: FolderNode[];
}

export interface ProjectDoc extends Document {
  name: string;
  description?: string;
  image?: string;
  rootFolders?: FolderNode[];
  allowUpload: boolean;
  allowSharing: boolean;
}

let ProjectModel: Model<ProjectDoc> | null = null;

export function initProjectModel(conn: Connection): Model<ProjectDoc> {
  if (ProjectModel) return ProjectModel;

  const folderNodeSchema = new Schema<FolderNode>({
    name: { type: String, required: true },
    children: [{ type: Object }],
  }, { _id: false });

  const projectSchema = new Schema<ProjectDoc>({
    name: { type: String, required: true },
    description: { type: String },
    image: { type: String },
    rootFolders: [folderNodeSchema],
    allowUpload: { type: Boolean, default: true },
    allowSharing: { type: Boolean, default: false },
  }, { timestamps: true });

  ProjectModel = conn.model<ProjectDoc>('Project', projectSchema);
  return ProjectModel;
}

import { ObjectId } from 'mongodb';
import { getModel } from '../models/manager';
import { StreamByConfig, Connection, ConnectionMethod, ProjectInfo } from '../types';
import { encrypt, isEncryptionKeySet } from '../utils/encryption';

export async function addConnection(
  config: StreamByConfig,
  projectId: string,
  data: { name: string; apiUrl: string; method: ConnectionMethod; prefix?: string; description?: string; token?: string }
): Promise<Connection> {
  const ProjectModel = getModel('projects');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) {
    throw new Error('Project not found.');
  }

  let encryptedCredential: string | undefined;
  if (data.token) {
    if (!isEncryptionKeySet()) throw new Error('Encryption key is not set. Cannot encrypt credential.');
    encryptedCredential = encrypt(data.token);
  }

  const connection: Connection = {
    id: new ObjectId().toHexString(),
    name: data.name,
    prefix: data.prefix,
    apiUrl: data.apiUrl,
    method: data.method,
    projectId,
    createdAt: new Date(),
    ...(data.description !== undefined && { description: data.description }),
    ...(encryptedCredential !== undefined && { encryptedCredential }),
  };

  const updatedProject = await ProjectModel.update(
    { _id: projectId },
    { $push: { connections: connection } }
  );

  if (!updatedProject) {
    throw new Error('Failed to add connection to project.');
  }

  return connection;
}

export async function updateConnection(
  config: StreamByConfig,
  projectId: string,
  connectionId: string,
  data: { name?: string; apiUrl?: string; method?: ConnectionMethod; prefix?: string; description?: string; token?: string }
): Promise<Connection> {
  const ProjectModel = getModel('projects');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) throw new Error('Project not found.');

  const connections: Connection[] = project.connections ?? [];
  const index = connections.findIndex((c: any) => c.id === connectionId);
  if (index === -1) throw new Error('Connection not found.');

  let encryptedCredential: string | undefined;
  if (data.token) {
    if (!isEncryptionKeySet()) throw new Error('Encryption key is not set. Cannot encrypt credential.');
    encryptedCredential = encrypt(data.token);
  }

  const updated: Connection = {
    ...connections[index],
    ...(data.name !== undefined && { name: data.name }),
    ...(data.apiUrl !== undefined && { apiUrl: data.apiUrl }),
    ...(data.method !== undefined && { method: data.method }),
    ...(data.prefix !== undefined && { prefix: data.prefix }),
    ...(data.description !== undefined && { description: data.description }),
    ...(encryptedCredential !== undefined && { encryptedCredential }),
  };

  connections[index] = updated;

  const result = await ProjectModel.update(
    { _id: projectId },
    { $set: { connections } }
  );

  if (!result) throw new Error('Failed to update connection.');

  return updated;
}

export async function deleteConnection(
  config: StreamByConfig,
  projectId: string,
  connectionId: string
): Promise<void> {
  const ProjectModel = getModel('projects');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) {
    throw new Error('Project not found.');
  }

  const updatedProject = await ProjectModel.update(
    { _id: projectId },
    { $pull: { connections: { id: connectionId } } }
  );

  if (!updatedProject) {
    throw new Error('Failed to delete connection from project.');
  }
}

import { ObjectId } from 'mongodb';
import { getModel } from '../models/manager';
import { StreamByConfig, ApiConnection, ApiConnectionMethod, ProjectInfo } from '../types';

export async function addApiConnection(
  config: StreamByConfig,
  projectId: string,
  data: { name: string; apiUrl: string; method: ApiConnectionMethod; prefix?: string; description?: string; credentialId?: string }
): Promise<ApiConnection> {
  const ProjectModel = getModel('projects');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) {
    throw new Error('Project not found.');
  }

  const connection: ApiConnection = {
    id: new ObjectId().toHexString(),
    name: data.name,
    prefix: data.prefix,
    apiUrl: data.apiUrl,
    method: data.method,
    projectId,
    createdAt: new Date(),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.credentialId !== undefined && { credentialId: data.credentialId }),
  };

  const updatedProject = await ProjectModel.update(
    { _id: projectId },
    { $push: { apiConnections: connection } }
  );

  if (!updatedProject) {
    throw new Error('Failed to add API connection to project.');
  }

  return connection;
}

export async function updateApiConnection(
  config: StreamByConfig,
  projectId: string,
  connectionId: string,
  data: { name?: string; apiUrl?: string; method?: ApiConnectionMethod; prefix?: string; description?: string; credentialId?: string }
): Promise<ApiConnection> {
  const ProjectModel = getModel('projects');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) throw new Error('Project not found.');

  const connections: ApiConnection[] = project.apiConnections ?? [];
  const index = connections.findIndex((c: any) => c.id === connectionId);
  if (index === -1) throw new Error('API connection not found.');

  const updated: ApiConnection = {
    ...connections[index],
    ...(data.name !== undefined && { name: data.name }),
    ...(data.apiUrl !== undefined && { apiUrl: data.apiUrl }),
    ...(data.method !== undefined && { method: data.method }),
    ...(data.prefix !== undefined && { prefix: data.prefix }),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.credentialId !== undefined && { credentialId: data.credentialId }),
  };

  connections[index] = updated;

  const result = await ProjectModel.update(
    { _id: projectId },
    { $set: { apiConnections: connections } }
  );

  if (!result) throw new Error('Failed to update API connection.');

  return updated;
}

export async function deleteApiConnection(
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
    { $pull: { apiConnections: { id: connectionId } } }
  );

  if (!updatedProject) {
    throw new Error('Failed to delete API connection from project.');
  }
}

import { Request } from 'express';
import { AuthProvider, ProjectProvider, StorageAdapter } from '../types';
import { deleteProjectImage } from './file';

export async function createProjectService(
  req: Request,
  authProvider: AuthProvider,
  projectProvider: ProjectProvider
) {
  const { name, description } = req.body;
  const auth = await authProvider(req);

  if (!name) {
    throw new Error('Project name is required');
  }

  const newProject = await projectProvider.create({
    name,
    userId: auth.userId,
    description: description || '',
  });

  return {
    success: true,
    project: newProject,
  };
}

export async function updateProjectService(
  req: Request,
  authProvider: AuthProvider,
  projectProvider: ProjectProvider
) {
  const { projectId } = req.params;
  const updates = req.body;
  const auth = await authProvider(req);

  const project = await projectProvider.getById(projectId);

  if (!project) {
    throw new Error('Project not found');
  }

  if (!project.members?.find((e) => e.userId === auth.userId)) {
    throw new Error('Unauthorized');
  }

  const updatedProject = await projectProvider.update(projectId, updates);

  return {
    success: true,
    project: updatedProject,
  };
}

export async function deleteProjectImageService(
  req: Request,
  authProvider: AuthProvider,
  projectProvider: ProjectProvider,
  storageAdapter: StorageAdapter
) {
  const { projectId } = req.params;
  const auth = await authProvider(req);

  const project = await projectProvider.getById(projectId);

  if (!project) {
    throw new Error('Project not found');
  }

  if (!project.members?.find((e) => e.userId === auth.userId)) {
    throw new Error('Unauthorized');
  }

  await deleteProjectImage(storageAdapter, projectId);

  return { success: true };
}

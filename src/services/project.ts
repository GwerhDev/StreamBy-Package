import { Request } from 'express';
import { ProjectProvider } from '../types';

export async function createProjectService(
  req: Request,
  projectProvider: ProjectProvider
) {
  const { userId, name, description } = req.body;

  if (!name) {
    throw new Error('Project name is required');
  }

  const newProject = await projectProvider.create({
    name,
    description: description || '',
    userId,
  });

  return {
    success: true,
    project: newProject,
  };
}

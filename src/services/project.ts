import { Request } from 'express';
import { AuthProvider, ProjectProvider, StreamByConfig } from '../types';

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

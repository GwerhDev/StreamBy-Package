import { Request } from 'express';
import { ProjectProvider } from '../types';

export async function createProjectService(
  req: Request,
  projectProvider: ProjectProvider
) {
  const { name, description } = req.body;

  if (!name) {
    throw new Error('Project name is required');
  }

  const newProject = await projectProvider.create({
    name,
    description: description || ''
  });

  return {
    success: true,
    project: {
      id: newProject.id,
      name: newProject.name,
      description: newProject.description,
      image: newProject.image,
      settings: newProject.settings,
      rootFolders: newProject.rootFolders || [],
    }
  };
}

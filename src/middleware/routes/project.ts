import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';

import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { getConnection } from '../../adapters/database/connectionManager';
import { sqlAdapter } from '../../adapters/database/sql';
import { authenticate } from '../../services/auth';

export function projectRouter(config: StreamByConfig): Router {
  const router = Router();
  router.use(authenticate(config));

  const Project = getModel('projects');

  const mapProjectToResponseFormat = (project: any, userId: string) => {
    const currentUserMember = project.members?.find((member: any) => member.userId === userId);
    return {
      id: project._id || project.id,
      dbType: project.dbType,
      name: project.name,
      image: project.image || '',
      archived: currentUserMember ? currentUserMember.archived || false : false,
    };
  };

  router.get('/projects', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const archivedQuery = req.query.archived;
      const filterArchived = archivedQuery !== undefined ? String(archivedQuery).toLowerCase() === 'true' : undefined;

      const allProjects = await Project.find({}); // Fetch all projects
      
      const projects = allProjects
        .filter(project => {
          const isMember = project.members?.some((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!isMember) return false;

          if (filterArchived !== undefined) {
            const currentUserMember = project.members?.find((member: any) => member.userId === auth.userId);
            return currentUserMember ? (currentUserMember.archived || false) === filterArchived : false;
          }
          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));
      res.json({ projects });
    } catch (err: any) {
      console.error('Error in /projects endpoint:', err);
      res.status(500).json({ error: 'Failed to list projects', details: err });
    }
  });

  router.post('/projects/create', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const { name, description, dbType, image } = req.body;

      const mainDb = config.databases?.find(db => db.main);
      if (!mainDb) {
        return res.status(500).json({ error: 'Main database not configured' });
      }
      const userDbType = mainDb.type;
      const User = getModel('users', userDbType);
      const user = await User.findOne({ _id: auth.userId });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const newProject = await Project.create({
        dbType: dbType || 'nosql',
        name,
        description: description || '',
        image: image || '',
        members: [{ userId: auth.userId, username: user.username, role: "admin", archived: false }]
      });

      res.status(201).json({ project: { ...newProject, id: newProject._id || newProject.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create project', details: err.message });
    }
  });

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      res.json({ project: { ...project, id: project._id || project.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project', details: err.message });
    }
  });

  router.patch('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      const updates = req.body;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Missing updates payload' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const updated = await Project.update({ _id: projectId }, updates);
      if (!updated) {
        return res.status(404).json({ error: 'Project not found or not updated' });
      }
      res.status(200).json({ success: true, project: { ...updated, id: updated._id || updated.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update project', details: err.message });
    }
  });

  router.delete('/projects/:id', async (req, res) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      await Project.delete({ _id: projectId });

      res.status(200).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete project', details: err.message });
    }
  });

  router.patch('/projects/:id/archive', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      if (project.dbType === 'sql') {
        const connection = getConnection(config.databases?.find(db => db.main)?.id || '').client;
        await sqlAdapter.update(
          connection as any,
          'project_members',
          { projectId: projectId, userId: auth.userId },
          { archived: true, archivedBy: auth.userId, archivedAt: new Date() }
        );
      } else {
        const memberIndex = project.members.findIndex((member: any) => member.userId === auth.userId);

        if (memberIndex === -1) {
          return res.status(403).json({ error: 'Unauthorized project access' });
        }

        project.members[memberIndex].archived = true;
        project.members[memberIndex].archivedBy = auth.userId;
        project.members[memberIndex].archivedAt = new Date();

        await Project.update(
          { _id: projectId },
          { members: project.members }
        );
      }

      // Re-fetch all projects for the user to ensure the list is up-to-date
      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const isMember = project.members?.some((m: any) => m.userId?.toString() === auth.userId?.toString());
          return isMember; // Only include projects where the user is a member
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));

      res.status(200).json({ success: true, projects: projects });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to archive project', details: err.message });
    }
  });

  router.patch('/projects/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      if (project.dbType === 'sql') {
        const connection = getConnection(config.databases?.find(db => db.main)?.id || '').client;
        await sqlAdapter.update(
          connection as any,
          'project_members',
          { projectId: projectId, userId: auth.userId },
          { archived: false, archivedBy: null, archivedAt: null }
        );
      } else {
        const memberIndex = project.members.findIndex((member: any) => member.userId === auth.userId);

        if (memberIndex === -1) {
          return res.status(403).json({ error: 'Unauthorized project access' });
        }

        project.members[memberIndex].archived = false;
        project.members[memberIndex].archivedBy = null;
        project.members[memberIndex].archivedAt = null;

        await Project.update(
          { _id: projectId },
          { members: project.members }
        );
      }

      // Re-fetch all projects for the user to ensure the list is up-to-date
      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const isMember = project.members?.some((m: any) => m.userId?.toString() === auth.userId?.toString());
          return isMember; // Only include projects where the user is a member
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));

      res.status(200).json({ success: true, projects: projects });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to unarchive project', details: err.message });
    }
  });

  router.get('/projects/:id/members', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const mainDb = config.databases?.find(db => db.main);
      if (!mainDb) {
        return res.status(500).json({ error: 'Main database not configured' });
      }
      const userDbType = mainDb.type;

      const User = getModel('users', userDbType);
      const membersWithUsernames = await Promise.all(
        project.members.map(async (member: any) => {
          const user = await User.findOne({ _id: member.userId });
          return {
            userId: member.userId,
            username: user ? user.username : 'Unknown',
            role: member.role,
            profilePic: user ? user.profilePic : ''
          };
        })
      );

      res.json({ members: membersWithUsernames });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch project members', details: err.message });
    }
  });

  router.post('/projects/:id/image', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { imageUrl } = req.body;

      if (!projectId || !imageUrl) {
        return res.status(400).json({ error: 'Missing projectId or imageUrl' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ error: 'Unauthorized project access' });
      }

      const updatedProject = await Project.update({ _id: projectId }, { image: imageUrl });

      if (!updatedProject) {
        return res.status(404).json({ error: 'Project not found or not updated' });
      }

      res.status(200).json({ success: true, project: { ...updatedProject, id: updatedProject._id || updatedProject.id, _id: undefined } });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update project image', details: err.message });
    }
  });

  return router;
}

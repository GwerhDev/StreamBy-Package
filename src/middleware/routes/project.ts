import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { getConnection } from '../../adapters/database/connectionManager';
import { sqlAdapter } from '../../adapters/database/sql';
import { sanitizeProject } from '../../utils/sanitize';
export function projectRouter(config: StreamByConfig): Router {
  const router = Router();

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
          const currentUserMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!currentUserMember || currentUserMember.status !== 'active') return false;

          if (filterArchived !== undefined) {
            return (currentUserMember.archived || false) === filterArchived;
          }
          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));
      res.json({ projects, message: 'Projects listed successfully' });
    } catch (err: any) {
      console.error('Error in /projects endpoint:', err);
      res.status(500).json({ message: 'Failed to list projects', details: err });
    }
  });

  router.get('/projects/explore', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const allProjects = await Project.find({});
      const result = allProjects
        .filter((p: any) => p.public !== false)
        .map((p: any) => ({
          id: p._id || p.id,
          name: p.name,
          description: p.description || '',
          image: p.image || '',
          memberCount: (p.members || []).filter((m: any) => m.status === 'active').length,
          isMember: (p.members || []).some((m: any) => m.userId?.toString() === auth.userId && m.status === 'active'),
          hasPendingRequest: (p.members || []).some((m: any) => m.userId?.toString() === auth.userId && m.status === 'pending'),
        }));
      res.json({ projects: result });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to explore projects', details: err.message });
    }
  });

  router.post('/projects/create', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;

      if ((req as any).subscription === 'freemium') {
        return res.status(403).json({ error: 'Freemium users cannot create projects' });
      }

      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const { name, description, image, allowedOrigin, public: isPublic = true, category } = req.body;

      if (isPublic === false && (req as any).subscription === 'freemium') {
        return res.status(403).json({ error: 'Private projects require a subscriber plan' });
      }

      const mainDb = config.databases?.find(db => db.main) ?? config.databases?.[0];
      if (!mainDb) {
        return res.status(500).json({ message: 'No database configured' });
      }
      const dbType = mainDb.type;
      const User = getModel('users', dbType);
      const user = await User.findOne({ _id: auth.userId });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const newProject = await Project.create({
        dbType,
        name,
        description: description || '',
        image: image || '',
        allowedOrigin: allowedOrigin || [],
        public: isPublic,
        category: category || null,
        members: [{ userId: auth.userId, username: user.username, role: "admin", status: "active", archived: false }],
      });

      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const currentUserMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!currentUserMember || currentUserMember.status !== 'active') return false;

          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));
      res.status(200).json({ success: true, projects: projects, projectId: newProject._id || newProject.id, message: 'Project created successfully' });
    } catch (err: any) {
      console.error('Error creating project:', err);
      res.status(500).json({ message: 'Failed to create project', details: err.message });
    }
  });

  router.get('/projects/:id/preview', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const currentMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
      const membership = currentMember
        ? { isMember: true, status: currentMember.status || 'active' }
        : { isMember: false, status: null };

      res.json({
        membership,
        project: {
          id: project._id || project.id,
          name: project.name,
          description: project.description || '',
          image: project.image || '',
          dbType: project.dbType,
          members: (project.members || [])
            .filter((m: any) => !m.archived)
            .map((m: any) => ({ role: m.role })),
          exports: (project.exports || []).map((e: any) => ({ method: e.method })),
        },
        message: 'Project preview fetched successfully',
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch project preview', details: err.message });
    }
  });

  router.get('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const exports = (project.exports || []).map((e: any) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        method: e.method,
        private: e.private,
        useConnections: e.useConnections,
        useCredentials: e.useCredentials,
      }));

      const sanitized = sanitizeProject({ ...project, id: project._id || project.id, _id: undefined, apiConnections: project.apiConnections || [], exports });
      res.json({ project: sanitized, message: 'Project fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch project', details: err.message });
    }
  });

  router.patch('/projects/:id', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const updates = req.body;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ message: 'Missing updates payload' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updated = await Project.update({ _id: projectId }, updates);
      if (!updated) {
        return res.status(404).json({ message: 'Project not found or not updated' });
      }
      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const currentUserMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!currentUserMember || currentUserMember.status !== 'active') return false;

          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));

      res.status(200).json({ success: true, projects: projects, projectId: updated._id || updated.id, message: 'Project updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update project', details: err.message });
    }
  });

  router.delete('/projects/:id', async (req, res) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      await Project.useDbType(project.dbType).delete({ _id: projectId });

      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const currentUserMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!currentUserMember || currentUserMember.status !== 'active') return false;

          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));

      res.status(200).json({ success: true, projects: projects, message: 'Project deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete project', details: err.message });
    }
  });

  router.patch('/projects/:id/archive', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      if (project.dbType === 'sql') {
        const connection = getConnection(config.databases?.find(db => db.main)?.id || '').client;
        await sqlAdapter.update(
          connection as any,
          'project_members',
          { projectId: projectId, userId: auth.userId },
          { archived: true, archivedBy: auth.userId, archivedAt: new Date() },
          'streamby'
        );
      } else {
        const memberIndex = project.members.findIndex((member: any) => member.userId === auth.userId);
        if (memberIndex === -1) {
          return res.status(403).json({ message: 'Unauthorized project access' });
        }
        project.members[memberIndex].archived = true;
        project.members[memberIndex].archivedBy = auth.userId;
        project.members[memberIndex].archivedAt = new Date();
        await Project.update({ _id: projectId }, { members: project.members });
      }

      // Re-fetch all projects for the user to ensure the list is up-to-date
      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const currentUserMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!currentUserMember || currentUserMember.status !== 'active') return false;
          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));

      res.status(200).json({ success: true, projects: projects, message: 'Project archived successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to archive project', details: err.message });
    }
  });

  router.patch('/projects/:id/unarchive', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project || !isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      if (project.dbType === 'sql') {
        const connection = getConnection(config.databases?.find(db => db.main)?.id || '').client;
        await sqlAdapter.update(
          connection as any,
          'project_members',
          { projectId: projectId, userId: auth.userId },
          { archived: false, archivedBy: null, archivedAt: null },
          'streamby'
        );
      } else {
        const memberIndex = project.members.findIndex((member: any) => member.userId === auth.userId);
        if (memberIndex === -1) {
          return res.status(403).json({ message: 'Unauthorized project access' });
        }
        project.members[memberIndex].archived = false;
        project.members[memberIndex].archivedBy = null;
        project.members[memberIndex].archivedAt = null;
        await Project.update({ _id: projectId }, { members: project.members });
      }

      // Re-fetch all projects for the user to ensure the list is up-to-date
      const allProjects = await Project.find({});
      const projects = allProjects
        .filter(project => {
          const currentUserMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
          if (!currentUserMember || currentUserMember.status !== 'active') return false;
          return true;
        })
        .map(project => mapProjectToResponseFormat(project, auth.userId));


      res.status(200).json({ success: true, projects: projects, message: 'Project unarchived successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to unarchive project', details: err.message });
    }
  });

  router.post('/projects/:id/image', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { imageUrl } = req.body;

      if (!projectId || !imageUrl) {
        return res.status(400).json({ message: 'Missing projectId or imageUrl' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updatedProject = await Project.update({ _id: projectId }, { image: imageUrl });

      if (!updatedProject) {
        return res.status(404).json({ message: 'Project not found or not updated' });
      }

      res.status(200).json({ success: true, project: sanitizeProject({ ...updatedProject, id: updatedProject._id || updatedProject.id, _id: undefined }), message: 'Project image updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update project image', details: err.message });
    }
  });

  router.patch('/projects/:id/origins', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin' && auth.role !== 'editor') {
        return res.status(403).json({ message: 'Permission denied' });
      }

      const projectId = req.params.id;
      const { origins } = req.body;

      const project = await Project.findOne({ _id: projectId });

      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const updated = await Project.update({ _id: projectId }, { allowedOrigin: origins });
      if (!updated) {
        return res.status(404).json({ message: 'Project not found or not updated' });
      }

      res.status(200).json({ success: true, project: sanitizeProject(updated), message: 'Project origins updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update project origins', details: err.message });
    }
  });

  return router;
}

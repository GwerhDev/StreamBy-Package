import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectMember } from '../../utils/auth';
import { getConnectedIds, getConnection } from '../../adapters/database/connectionManager';
import { sqlAdapter } from '../../adapters/database/sql';
import { createNotification } from '../../services/notification';

const VALID_ROLES = ['viewer', 'editor', 'admin'] as const;
type MemberRole = typeof VALID_ROLES[number];

export function memberRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  const getSqlConnection = () => {
    const sqlDb = config.databases?.find(db => db.type === 'sql');
    if (!sqlDb || !getConnectedIds().includes(sqlDb.id)) return null;
    return getConnection(sqlDb.id).client;
  };

  router.get('/projects/:id/members', async (req: Request, res: Response) => {
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

      const mainDb = config.databases?.find(db => db.main);
      if (!mainDb) {
        return res.status(500).json({ message: 'Main database not configured' });
      }

      const User = getModel('users', mainDb.type);
      const membersWithUsernames = await Promise.all(
        project.members.map(async (member: any) => {
          const user = await User.findOne({ _id: member.userId });
          
          return {
            userId: member.userId,
            username: user ? user.username : 'Unknown',
            role: member.role,
            status: member.status,
            profilePic: user ? user.profilePic : user.googlePic,
          };
        })
      );

      res.json({ members: membersWithUsernames, message: 'Project members fetched successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch project members', details: err.message });
    }
  });

  router.post('/projects/:id/members', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can invite members' });
      }

      const projectId = req.params.id;
      const { userId, role } = req.body;

      if (!userId || !role) {
        return res.status(400).json({ message: 'userId and role are required' });
      }
      if (!VALID_ROLES.includes(role as MemberRole)) {
        return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const alreadyMember = project.members?.some((m: any) => m.userId?.toString() === userId?.toString());
      if (alreadyMember) {
        return res.status(400).json({ message: 'User is already a member of this project' });
      }

      const User = getModel('users');
      const user = await User.findOne({ _id: userId });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const newMember = { userId, username: user.username, role, archived: false, status: 'pending', invitedBy: auth.userId };

      if (project.dbType === 'sql') {
        const connection = getSqlConnection();
        if (!connection) {
          return res.status(503).json({ message: 'SQL connection not available' });
        }
        await sqlAdapter.create(connection as any, 'project_members', {
          projectId,
          userId,
          role,
          archived: false,
          status: 'pending',
          invitedBy: auth.userId,
        }, 'streamby');
      } else {
        await Project.update({ _id: projectId }, { $push: { members: newMember } });
      }

      await createNotification(
        userId,
        'member_invited',
        `You has been invited to join the project "${project.name}"`,
        { projectId, role, invitedBy: auth.userId },
      );

      res.status(201).json({ member: newMember, message: 'Member invited successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to invite member', details: err.message });
    }
  });

  router.patch('/projects/:id/members/:userId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can update member roles' });
      }

      const projectId = req.params.id;
      const targetUserId = req.params.userId;
      const { role } = req.body;

      if (!role || !VALID_ROLES.includes(role as MemberRole)) {
        return res.status(400).json({ message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const memberExists = project.members?.some((m: any) => m.userId?.toString() === targetUserId?.toString());
      if (!memberExists) {
        return res.status(404).json({ message: 'Member not found in project' });
      }

      if (project.dbType === 'sql') {
        const connection = getSqlConnection();
        if (!connection) {
          return res.status(503).json({ message: 'SQL connection not available' });
        }
        await sqlAdapter.update(connection as any, 'project_members', { projectId, userId: targetUserId }, { role }, 'streamby');
      } else {
        const updatedMembers = project.members.map((m: any) =>
          m.userId?.toString() === targetUserId?.toString() ? { ...m, role } : m
        );
        await Project.update({ _id: projectId }, { members: updatedMembers });
      }

      res.status(200).json({ message: 'Member role updated successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update member role', details: err.message });
    }
  });

  router.patch('/projects/:id/members/:userId/accept', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { id: projectId, userId: targetUserId } = req.params;

      if (auth.userId !== targetUserId) {
        return res.status(403).json({ message: 'You can only accept your own invitations' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const member = project.members?.find((m: any) => m.userId?.toString() === targetUserId);
      if (!member) {
        return res.status(404).json({ message: 'Invitation not found' });
      }
      if (member.status !== 'pending') {
        return res.status(400).json({ message: 'Invitation is no longer pending' });
      }

      const updatedMembers = project.members.map((m: any) =>
        m.userId?.toString() === targetUserId ? { ...m, status: 'active' } : m
      );
      await Project.update({ _id: projectId }, { members: updatedMembers });

      await createNotification(
        member.invitedBy,
        'member_accepted',
        `${member.username} aceptó la invitación al proyecto "${project.name}"`,
        { projectId, userId: targetUserId },
      );

      res.status(200).json({ message: 'Invitation accepted' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to accept invitation', details: err.message });
    }
  });

  router.patch('/projects/:id/members/:userId/reject', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { id: projectId, userId: targetUserId } = req.params;

      if (auth.userId !== targetUserId) {
        return res.status(403).json({ message: 'You can only reject your own invitations' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const member = project.members?.find((m: any) => m.userId?.toString() === targetUserId);
      if (!member) {
        return res.status(404).json({ message: 'Invitation not found' });
      }
      if (member.status !== 'pending') {
        return res.status(400).json({ message: 'Invitation is no longer pending' });
      }

      await Project.update({ _id: projectId }, { $pull: { members: { userId: targetUserId } } });

      await createNotification(
        member.invitedBy,
        'member_rejected',
        `${member.username} rechazó la invitación al proyecto "${project.name}"`,
        { projectId, userId: targetUserId },
      );

      res.status(200).json({ message: 'Invitation rejected' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to reject invitation', details: err.message });
    }
  });

  router.post('/projects/:id/request-join', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const projectId = req.params.id;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (project.public === false) {
        return res.status(403).json({ message: 'This project is not open for join requests' });
      }

      const alreadyMember = project.members?.some((m: any) => m.userId?.toString() === auth.userId?.toString());
      if (alreadyMember) {
        return res.status(400).json({ message: 'You are already a member or have a pending request' });
      }

      const User = getModel('users');
      const user = await User.findOne({ _id: auth.userId });
      const username = user?.username || auth.username;

      if (project.dbType === 'sql') {
        const connection = getSqlConnection();
        if (!connection) {
          return res.status(503).json({ message: 'SQL connection not available' });
        }
        await sqlAdapter.create(connection as any, 'project_members', {
          projectId,
          userId: auth.userId,
          role: 'viewer',
          archived: false,
          status: 'pending',
          invitedBy: auth.userId,
        }, 'streamby');
      } else {
        await Project.update({ _id: projectId }, {
          $push: { members: { userId: auth.userId, username, role: 'viewer', archived: false, status: 'pending', invitedBy: auth.userId } },
        });
      }

      const admins = (project.members || []).filter((m: any) => m.role === 'admin' && m.status === 'active');
      await Promise.all(admins.map((admin: any) =>
        createNotification(
          admin.userId,
          'join_request',
          `${username} has requested to join "${project.name}"`,
          { projectId, userId: auth.userId },
        )
      ));

      res.status(201).json({ message: 'Join request sent successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to send join request', details: err.message });
    }
  });

  router.patch('/projects/:id/members/:userId/approve', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { id: projectId, userId: targetUserId } = req.params;

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const requestingMember = project.members?.find((m: any) => m.userId?.toString() === auth.userId?.toString());
      if (!requestingMember || requestingMember.status !== 'active' || requestingMember.role !== 'admin') {
        return res.status(403).json({ message: 'Only project admins can approve requests' });
      }

      const targetMember = project.members?.find((m: any) => m.userId?.toString() === targetUserId?.toString());
      if (!targetMember) {
        return res.status(404).json({ message: 'Member not found in project' });
      }
      if (targetMember.status !== 'pending') {
        return res.status(400).json({ message: 'No pending request for this user' });
      }

      if (project.dbType === 'sql') {
        const connection = getSqlConnection();
        if (!connection) {
          return res.status(503).json({ message: 'SQL connection not available' });
        }
        await sqlAdapter.update(connection as any, 'project_members', { projectId, userId: targetUserId }, { status: 'active' }, 'streamby');
      } else {
        const updatedMembers = project.members.map((m: any) =>
          m.userId?.toString() === targetUserId ? { ...m, status: 'active' } : m
        );
        await Project.update({ _id: projectId }, { members: updatedMembers });
      }

      await createNotification(
        targetUserId,
        'join_approved',
        `Your request to join "${project.name}" has been approved`,
        { projectId },
      );

      res.status(200).json({ message: 'Join request approved' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to approve join request', details: err.message });
    }
  });

  router.delete('/projects/:id/members/:userId', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      if (auth.role !== 'admin') {
        return res.status(403).json({ message: 'Only admins can remove members' });
      }

      const projectId = req.params.id;
      const targetUserId = req.params.userId;

      if (targetUserId === auth.userId) {
        return res.status(400).json({ message: 'Cannot remove yourself from the project' });
      }

      const project = await Project.findOne({ _id: projectId });
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!isProjectMember(project, auth.userId)) {
        return res.status(403).json({ message: 'Unauthorized project access' });
      }

      const memberExists = project.members?.some((m: any) => m.userId?.toString() === targetUserId?.toString());
      if (!memberExists) {
        return res.status(404).json({ message: 'Member not found in project' });
      }

      if (project.dbType === 'sql') {
        const connection = getSqlConnection();
        if (!connection) {
          return res.status(503).json({ message: 'SQL connection not available' });
        }
        await sqlAdapter.delete(connection as any, 'project_members', { projectId, userId: targetUserId }, 'streamby');
      } else {
        await Project.update({ _id: projectId }, { $pull: { members: { userId: targetUserId } } });
      }

      res.status(200).json({ message: 'Member removed successfully' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to remove member', details: err.message });
    }
  });

  return router;
}

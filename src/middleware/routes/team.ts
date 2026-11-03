import { Router, Request, Response } from 'express';
import { Auth, StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectAdmin, isProjectMember } from '../../utils/auth';
import { checkTeam, createTeam, deleteTeam, listTeams, Team, unassignTeam, updateTeam } from '../../services/teams';

// A project's teams: any member sees them, its admins make, change and delete them. Each change
// answers the teams as they are then.
export function teamRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // Its teams, each member with their username (and picture).
  const answerTeams = async (project: any) => {
    const found = await listTeams(project);
    if (!found) return null;
    const mainDb = config.databases?.find(db => db.main);
    const User = getModel('users', mainDb?.type);
    const ids = [...new Set(found.flatMap(t => t.memberIds))];
    const users = new Map(await Promise.all(ids.map(async id => [id, await User.findOne({ _id: id }).catch(() => null)] as const)));
    return found.map((team: Team) => ({
      id: team.id, name: team.name, createdAt: team.createdAt, updatedAt: team.updatedAt,
      members: team.memberIds.map(userId => {
        const user: any = users.get(userId);
        return { userId, username: user?.username ?? 'Unknown', profilePic: user?.profilePic ?? user?.googlePic ?? null };
      }),
    }));
  };

  const projectOf = async (req: Request, res: Response, { admin }: { admin: boolean }) => {
    const auth = (req as any).auth as Auth;
    const project = await Project.findOne({ _id: req.params.id });
    if (!project) { res.status(404).json({ message: 'Project not found' }); return null; }
    if (!isProjectMember(project, auth.userId)) { res.status(403).json({ message: 'Unauthorized project access' }); return null; }
    if (admin && !isProjectAdmin(project, auth.userId)) { res.status(403).json({ message: 'Only a project admin can manage its teams' }); return null; }
    return project;
  };

  router.get('/projects/:id/teams', async (req: Request, res: Response) => {
    try {
      const project = await projectOf(req, res, { admin: false });
      if (!project) return;
      const teams = await answerTeams(project);
      if (!teams) return res.status(500).json({ message: 'Database not available' });
      res.json({ teams });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch teams', details: err.message });
    }
  });

  router.post('/projects/:id/teams', async (req: Request, res: Response) => {
    try {
      const project = await projectOf(req, res, { admin: true });
      if (!project) return;
      if (!(await listTeams(project))) return res.status(500).json({ message: 'Database not available' });
      const checked = await checkTeam(project, req.body, { creating: true });
      if ('error' in checked) return res.status(checked.status ?? 400).json({ message: checked.error });
      await createTeam(req.params.id, checked.values, ((req as any).auth as Auth).userId);
      res.status(201).json({ teams: await answerTeams(project), message: 'Team created' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to create the team', details: err.message });
    }
  });

  router.patch('/projects/:id/teams/:teamId', async (req: Request, res: Response) => {
    try {
      const project = await projectOf(req, res, { admin: true });
      if (!project) return;
      if (!(await listTeams(project))) return res.status(500).json({ message: 'Database not available' });
      const checked = await checkTeam(project, req.body, { teamId: req.params.teamId });
      if ('error' in checked) return res.status(checked.status ?? 400).json({ message: checked.error });
      if (!(await updateTeam(req.params.id, req.params.teamId, checked.values))) return res.status(404).json({ message: 'Team not found' });
      res.json({ teams: await answerTeams(project), message: 'Team updated' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update the team', details: err.message });
    }
  });

  router.delete('/projects/:id/teams/:teamId', async (req: Request, res: Response) => {
    try {
      const project = await projectOf(req, res, { admin: true });
      if (!project) return;
      if (!(await listTeams(project))) return res.status(500).json({ message: 'Database not available' });
      if (!(await deleteTeam(req.params.id, req.params.teamId))) return res.status(404).json({ message: 'Team not found' });
      // What it was assigned to stays, without it.
      await unassignTeam(req.params.id, req.params.teamId);
      res.json({ teams: await answerTeams(project), message: 'Team deleted' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete the team', details: err.message });
    }
  });

  return router;
}

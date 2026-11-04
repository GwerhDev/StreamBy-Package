import { Router, Request, Response } from 'express';
import { Auth, StreamByConfig } from '../../types';
import { getModel } from '../../models/manager';
import { isProjectAdmin, isProjectMember } from '../../utils/auth';
import { forgetTeamPermissions, readProjectPermissions, roleMay } from '../../services/projectPermissions';
import { checkTeam, createTeam, deleteTeam, listTeams, Team, unassignTeam, updateTeam } from '../../services/teams';

// A project's teams: any member sees them; its admins, and its editors if the project lets them,
// make, change and delete them. Each change answers the teams as they are then.
//
// A team the project's permissions have actions for grants them to its editors: who is in it, and
// whether it's there at all, is then the admins' to decide (only an admin grants a permission).
// Someone else who manages teams may still make new ones (they grant nothing) and rename any.
export function teamRouter(config: StreamByConfig): Router {
  const router = Router();
  const Project = getModel('projects');

  // Whether a team grants permissions: the project's permissions have actions for it.
  const grantingTeams = async (projectId: string) =>
    new Set(Object.entries((await readProjectPermissions(projectId)).teams).filter(([, actions]) => actions.length).map(([id]) => id));

  // Its teams, each member with their username (and picture), and whether it grants permissions.
  const answerTeams = async (project: any) => {
    const found = await listTeams(project);
    if (!found) return null;
    const granting = await grantingTeams(String(project._id ?? project.id));
    const mainDb = config.databases?.find(db => db.main);
    const User = getModel('users', mainDb?.type);
    const ids = [...new Set(found.flatMap(t => t.memberIds))];
    // All of them at once, not one by one.
    const people = ids.length ? await User.find({ ids }) : [];
    const users = new Map(people.map((u: any) => [String(u._id ?? u.id), u] as const));
    return found.map((team: Team) => ({
      id: team.id, name: team.name, createdAt: team.createdAt, updatedAt: team.updatedAt,
      grantsPermissions: granting.has(team.id),
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
    // Its admins, and its editors if the project lets them (see projectPermissions).
    if (admin && !(await roleMay(project, auth.userId, 'teams:manage'))) { res.status(403).json({ message: 'Your role in this project can\'t manage its teams' }); return null; }
    return project;
  };

  // A team that grants permissions, changed by someone who isn't an admin: refused (an admin, or a
  // project's token, which acts as one, may). True when the request was answered.
  const PROTECTED = "This team grants permissions: its members are managed by the project's admins";
  const refusedOnGrantingTeam = async (req: Request, res: Response, project: any) => {
    if (isProjectAdmin(project, ((req as any).auth as Auth).userId)) return false;
    if (!(await grantingTeams(req.params.id)).has(req.params.teamId)) return false;
    res.status(403).json({ message: PROTECTED });
    return true;
  };
  const sameMembers = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

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
      // Renaming changes nothing of who has what; changing its members does.
      if (checked.values.memberIds !== undefined) {
        const current = (await listTeams(project))!.find(t => t.id === req.params.teamId);
        if (current && !sameMembers(current.memberIds, checked.values.memberIds) && (await refusedOnGrantingTeam(req, res, project))) return;
      }
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
      if (await refusedOnGrantingTeam(req, res, project)) return;
      if (!(await deleteTeam(req.params.id, req.params.teamId))) return res.status(404).json({ message: 'Team not found' });
      // What it was assigned to stays, without it.
      await unassignTeam(req.params.id, req.params.teamId);
      // Nor does it add anything for its members.
      await forgetTeamPermissions(req.params.id, req.params.teamId);
      res.json({ teams: await answerTeams(project), message: 'Team deleted' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to delete the team', details: err.message });
    }
  });

  return router;
}

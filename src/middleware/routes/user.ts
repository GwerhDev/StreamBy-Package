import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';

export function userRouter(config: StreamByConfig): Router {
  const router = Router();
  const User = getModel('users');

  router.get('/users/search', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const q = (req.query.q as string || '').trim();

      if (!q) {
        return res.status(400).json({ message: 'Query param q is required' });
      }

      const allUsers = await User.find({});
      const lower = q.toLowerCase();

      const users = allUsers
        .filter((u: any) => u.username?.toLowerCase().includes(lower))
        .slice(0, 20)
        .map((u: any) => ({
          id: u._id || u.id,
          username: u.username,
          profilePic: u.profilePic || '',
        }));

      res.json({ users });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to search users', details: err.message });
    }
  });

  return router;
}

import { Router, Request, Response, NextFunction } from 'express';
import { StreamByConfig, Auth, UserPlan } from '../../types';
import { getModel } from '../../models/manager';

const resolveSubscription = async (auth: Auth): Promise<UserPlan> => {
  const Subscription = getModel('user_subscriptions');

  const existing = await Subscription.findOne({ user_id: auth.userId });
  if (existing) return (existing as any).plan as UserPlan;

  const plan: UserPlan = auth.role === 'admin' ? 'admin' : 'freemium';
  await Subscription.create({ user_id: auth.userId, plan, dbType: 'sql' } as any);
  return plan;
};

export const ensureSubscription = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = (req as any).auth as Auth;
    const plan = await resolveSubscription(auth);
    (req as any).subscription = plan;
    next();
  } catch (err: any) {
    res.status(403).json({ error: 'Unauthorized', details: err.message });
  }
};

export function subscriptionRouter(config: StreamByConfig): Router {
  const router = Router();

  router.get('/user/subscription', async (req: Request, res: Response) => {
    res.json({ subscription: (req as any).subscription });
  });

  return router;
}

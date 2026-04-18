import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';

export function notificationRouter(config: StreamByConfig): Router {
  const router = Router();
  const Notification = getModel('notifications');

  router.get('/notifications', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const notifications = await Notification.find({ userId: auth.userId, read: false });
      res.status(200).json({ data: notifications });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch notifications', details: err.message });
    }
  });

  router.patch('/notifications/read-all', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const model = (Notification as any);
      if (model.updateMany) {
        await model.updateMany({ userId: auth.userId, read: false }, { $set: { read: true, readAt: new Date() } });
      }
      res.status(200).json({ message: 'All notifications marked as read' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update notifications', details: err.message });
    }
  });

  router.patch('/notifications/:id/read', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { id } = req.params;
      await Notification.update({ _id: id, userId: auth.userId }, { read: true, readAt: new Date() });
      res.status(200).json({ message: 'Notification marked as read' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update notification', details: err.message });
    }
  });

  return router;
}

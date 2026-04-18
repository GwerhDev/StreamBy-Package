import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';

const MAX_NOTIFICATIONS = 20;

function getCollections() {
  const notifCollection = getModel('notifications', 'nosql') as any;
  const usersCollection = getModel('users', 'sql') as any;
  return { notifCollection, usersCollection };
}

export function notificationRouter(config: StreamByConfig): Router {
  const router = Router();

  router.get('/notifications', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const limit = Math.min(parseInt(req.query.limit as string) || MAX_NOTIFICATIONS, MAX_NOTIFICATIONS);
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const skip = (page - 1) * limit;
      const appIdQuery = req.query.appId as string | undefined;

      const { notifCollection, usersCollection } = getCollections();
      if (!notifCollection || !usersCollection) {
        return res.status(500).json({ message: 'Database not available' });
      }

      const notifications = await notifCollection.find({ userId: auth.userId.toString() });

      if (notifications.length === 0) {
        return res.status(200).json({
          data: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }

      res.status(200).json({
        data: notifications,
        pagination: { page, limit, total: notifications.length, pages: Math.ceil(notifications.length / limit) },
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch notifications', details: err.message });
    }
  });

  router.patch('/notifications/read-all', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const appIdQuery = req.query.appId as string | undefined;
      const { notifCollection, usersCollection } = getCollections();

      if (notifCollection && usersCollection) {
        const userDoc = await usersCollection.findOne({ id: auth.userId });
        const notificationIds: any[] = userDoc?.notifications || [];

        if (notificationIds.length > 0) {
          const filter: any = { _id: { $in: notificationIds }, read: false };
          if (appIdQuery !== undefined) {
            filter.appId = appIdQuery === '0' ? null : appIdQuery;
          }
          await notifCollection.updateMany(filter, { $set: { read: true, readAt: new Date() } });
        }
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
      const { notifCollection, usersCollection } = getCollections();

      if (notifCollection && usersCollection) {
        const userDoc = await usersCollection.findOne({ userId: auth.userId });
        const notificationIds: any[] = userDoc?.notifications || [];

        const belongsToUser = notificationIds.some(
          (nId: any) => nId.toString() === id.toString(),
        );
        if (!belongsToUser) {
          return res.status(403).json({ message: 'Notification not found or access denied' });
        }

        await notifCollection.updateOne(
          { _id: notificationIds.find((nId: any) => nId.toString() === id.toString()) },
          { $set: { read: true, readAt: new Date() } },
        );
      }

      res.status(200).json({ message: 'Notification marked as read' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update notification', details: err.message });
    }
  });

  return router;
}

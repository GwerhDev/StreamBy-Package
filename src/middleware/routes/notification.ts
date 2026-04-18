import { Router, Request, Response } from 'express';
import { StreamByConfig, Auth } from '../../types';
import { getModel } from '../../models/manager';
import { getConnection, getConnectedIds } from '../../adapters/database/connectionManager';
import { MongoClient, ObjectId } from 'mongodb';

const MAX_NOTIFICATIONS = 20;

function getRawNotifCollection() {
  const model = getModel('notifications', 'nosql') as any;
  const connectionIds: string[] = model.getConnectionIds();
  const activeId = connectionIds.find((id: string) =>
    getConnectedIds().includes(id) && getConnection(id).type === 'nosql',
  );
  if (!activeId) return null;
  return (getConnection(activeId).client as MongoClient).db().collection('notifications');
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

      const collection = getRawNotifCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const filter: any = { userId: auth.userId.toString() };
      if (appIdQuery !== undefined) {
        filter.appId = appIdQuery === '0' ? null : appIdQuery;
      }

      const total = await collection.countDocuments(filter);
      const notifications = await collection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.status(200).json({
        data: notifications,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to fetch notifications', details: err.message });
    }
  });

  router.patch('/notifications/read-all', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const appIdQuery = req.query.appId as string | undefined;

      const collection = getRawNotifCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      const filter: any = { userId: auth.userId.toString(), read: false };
      if (appIdQuery !== undefined) {
        filter.appId = appIdQuery === '0' ? null : appIdQuery;
      }

      await collection.updateMany(filter, { $set: { read: true, readAt: new Date() } });

      res.status(200).json({ message: 'All notifications marked as read' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update notifications', details: err.message });
    }
  });

  router.patch('/notifications/:id/read', async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as Auth;
      const { id } = req.params;

      const collection = getRawNotifCollection();
      if (!collection) return res.status(500).json({ message: 'Database not available' });

      await collection.updateOne(
        { _id: new ObjectId(id), userId: auth.userId.toString() },
        { $set: { read: true, readAt: new Date() } },
      );

      res.status(200).json({ message: 'Notification marked as read' });
    } catch (err: any) {
      res.status(500).json({ message: 'Failed to update notification', details: err.message });
    }
  });

  return router;
}

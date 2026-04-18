import { getModel } from '../models/manager';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';
import { MongoClient } from 'mongodb';
import { emitToUser } from './wsHub';

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

export async function createNotification(
  userId: string,
  type: string,
  message: string,
  data?: any,
  appId?: string,
  callback?: string,
) {
  const Notification = getModel('notifications', 'nosql');
  const notification = await Notification.create({
    userId,
    appId: appId ?? null,
    type,
    message,
    data: data ?? null,
    callback: callback ?? null,
    read: false,
    readAt: null,
    createdAt: new Date(),
  });

  const collection = getRawNotifCollection();
  if (collection) {
    const count = await collection.countDocuments({ userId });
    if (count > MAX_NOTIFICATIONS) {
      const oldest = await collection.find({ userId }).sort({ createdAt: 1 }).limit(1).toArray();
      if (oldest.length > 0) await collection.deleteOne({ _id: oldest[0]._id });
    }
  }

  emitToUser(userId, { type: 'notification', data: notification });
  return notification;
}

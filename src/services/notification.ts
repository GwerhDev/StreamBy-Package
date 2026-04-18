import { getModel } from '../models/manager';
import { emitToUser } from './wsHub';

const MAX_NOTIFICATIONS = 20;

function getCollections() {
  const notifCollection = getModel('notifications', 'nosql') as any;
  const usersCollection = getModel('users', 'sql') as any;
  return { notifCollection, usersCollection };
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

  const { notifCollection, usersCollection } = getCollections();

  if (notifCollection && usersCollection) {
    const userDoc = await usersCollection.findOne({ id: userId });
    const currentIds: any[] = userDoc?.notifications || [];

    if (currentIds.length >= MAX_NOTIFICATIONS) {
      const oldestId = currentIds[0];
      await notifCollection.deleteOne({ _id: oldestId });
    }
  }

  emitToUser(userId, { type: 'notification', data: notification });
  return notification;
}

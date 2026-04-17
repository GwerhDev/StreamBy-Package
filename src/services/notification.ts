import { getModel } from '../models/manager';
import { emitToUser } from './wsHub';

export async function createNotification(
  userId: string,
  type: string,
  message: string,
  data?: any,
  appId?: string,
  callback?: string,
) {
  const Notification = getModel('notifications');
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

  emitToUser(userId, { type: 'notification', data: notification });
  return notification;
}

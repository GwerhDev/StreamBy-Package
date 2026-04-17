import { getModel } from '../models/manager';
import { emitToUser } from './wsHub';

export async function createNotification(
  userId: string,
  type: string,
  message: string,
  data?: any,
) {
  const Notification = getModel('notifications');
  const notification = await Notification.create({
    userId,
    type,
    message,
    data: data ?? null,
    read: false,
    createdAt: new Date(),
  });

  emitToUser(userId, { type: 'notification', data: notification });
  return notification;
}

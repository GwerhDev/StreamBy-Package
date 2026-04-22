import { WebSocketServer, WebSocket } from 'ws';
import { StreamByConfig } from '../types';

const connections = new Map<string, Set<WebSocket>>();

export function initWsHub(wss: WebSocketServer, config: StreamByConfig): void {
  console.log('🟢 WebSocket hub connected');

  wss.on('connection', async (ws, req) => {
    let userId: string | null = null;

    try {
      const auth = await config.authProvider(req as any);
      if (!auth?.userId) {
        console.warn('⚠️  WS auth returned no userId — closing connection');
        ws.close(1008, 'Unauthorized');
        return;
      }
      userId = auth.userId;
    } catch (err) {
      console.error('❌ WS auth error:', err);
      ws.close(1008, 'Unauthorized');
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      console.warn(`⚠️  WS closed before setup completed for user ${userId}`);
      return;
    }

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId)!.add(ws);

    ws.on('close', () => {
      connections.get(userId!)?.delete(ws);
      if (connections.get(userId!)?.size === 0) connections.delete(userId!);
    });

    try {
      ws.send(JSON.stringify({ type: 'connected', userId }));
    } catch (err) {
      console.error(`❌ WS send error for user ${userId}:`, err);
    }
  });
}

export function emitToUser(userId: string, event: object): void {
  const userConnections = connections.get(userId);
  if (!userConnections) return;
  const payload = JSON.stringify(event);
  for (const ws of userConnections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

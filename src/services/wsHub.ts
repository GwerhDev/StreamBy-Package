import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { StreamByConfig } from '../types';

const connections = new Map<string, Set<WebSocket>>();

export function initWsHub(server: Server, config: StreamByConfig, path = '/streamby/ws'): void {
  const wss = new WebSocketServer({ server, path });

  wss.on('connection', async (ws, req) => {
    let userId: string | null = null;

    try {
      const auth = await config.authProvider(req as any);
      if (!auth?.userId) { ws.close(1008, 'Unauthorized'); return; }
      userId = auth.userId;
    } catch {
      ws.close(1008, 'Unauthorized');
      return;
    }

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId)!.add(ws);

    ws.on('close', () => {
      connections.get(userId!)?.delete(ws);
      if (connections.get(userId!)?.size === 0) connections.delete(userId!);
    });

    ws.send(JSON.stringify({ type: 'connected', userId }));
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

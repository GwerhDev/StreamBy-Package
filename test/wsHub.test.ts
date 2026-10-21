import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { initWsHub, emitToUser } from '../src/services/wsHub';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

// A hub whose authProvider answers with `auth`, and a client connected to it.
const connect = async (auth: object) => {
  const server = http.createServer();
  servers.push(server);
  const wss = new WebSocketServer({ server, path: '/streamby/ws' });
  initWsHub(wss, { storageProviders: [], authProvider: async () => auth as any });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/streamby/ws`);
  const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  const closed = new Promise<{ code: number; reason: string }>(resolve =>
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  return { ws, messages, closed, wss };
};

describe('initWsHub', () => {
  it('connects a session, and gets its user\'s events', async () => {
    const { ws, messages } = await connect({ userId: 'session-user', username: 'u', role: 'viewer' });
    await new Promise<void>(resolve => ws.on('open', () => resolve()));
    await expect.poll(() => messages[0]).toEqual({ type: 'connected', userId: 'session-user' });
    emitToUser('session-user', { type: 'notification', id: 'n1' });
    await expect.poll(() => messages.length).toBe(2);
    expect(messages[1]).toEqual({ type: 'notification', id: 'n1' });
    ws.close();
  });

  it("doesn't let an API token open it, nor sends it its owner's events", async () => {
    const scope = { tokenId: 't1', access: 'read', projectIds: ['p1'] };
    const { messages, closed } = await connect({ userId: 'token-owner', username: 'o', role: 'viewer', apiToken: scope });
    expect(await closed).toEqual({ code: 1008, reason: "API tokens can't open the WebSocket" });
    emitToUser('token-owner', { type: 'notification', id: 'n1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(messages).toEqual([]);
  });
});

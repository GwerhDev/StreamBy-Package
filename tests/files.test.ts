import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStreamByRouter } from '../src/middleware/createRouter';
import { mockAuthProvider } from './mocks/mockAuth';
import { mockAdapter } from './mocks/mockAdapter';

const app = express();

app.use(
  '/streamby',
  createStreamByRouter({
    storageProvider: {
      type: 's3',
      config: {} as any,
    },
    authProvider: mockAuthProvider,
    adapter: mockAdapter,
  })
);

describe('GET /streamby/files', () => {
  it('should return empty list or mocked files', async () => {
    const res = await request(app).get('/streamby/files');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});


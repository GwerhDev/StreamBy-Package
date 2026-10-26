import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { WebSocketServer } from 'ws';
import { StreamByConfig } from './src/types';
import { createStreamByRouter } from './src/middleware/createRouter';
import { resolveApiToken, API_TOKEN_PREFIX } from './src/services/apiTokens';

dotenv.config();

const config = {
  port: process.env.PORT || 4000,
  dummyId: process.env.DUMMY_ID,
  awsBucket: process.env.AWS_BUCKET,
  awsAccessKey: process.env.AWS_ACCESS_KEY,
  awsSecretKey: process.env.AWS_SECRET_KEY,
  awsBucketRegion: process.env.AWS_BUCKET_REGION,
  mongoUri: process.env.MONGO_URI,
  postgresUri: process.env.POSTGRES_URI,
  encryptionKey: process.env.STREAMBY_ENCRYPTION_KEY,
};

async function main() {
  const devApp = express();
  const server = http.createServer(devApp);
  const wss = new WebSocketServer({ server, path: '/streamby/ws' });

  devApp.use(cors({
    origin: 'http://localhost:5173',
    credentials: true
  }));

  const streambyConfig: StreamByConfig = {
    // The dev user, or an API token's owner with its scope (as a host's authProvider does), so
    // the MCP server can be tried locally.
    authProvider: async (req) => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      if (bearer?.startsWith(API_TOKEN_PREFIX)) {
        const resolved = await resolveApiToken(bearer);
        if (!resolved) throw new Error('Invalid API token');
        // A project's token is no user: it goes by its name.
        const username = resolved.scope.kind === 'project' ? resolved.name : 'dev-user';
        return { userId: resolved.userId, username, role: 'admin', apiToken: resolved.scope };
      }
      return {
        userId: config.dummyId || 'dummy-user-id',
        username: 'dev-user',
        role: 'admin'
      };
    },
    databases: [
      {
        id: 'mongo',
        type: 'nosql',
        connectionString: config.mongoUri!,
      },
      {
        id: 'postgres',
        type: 'sql',
        connectionString: config.postgresUri!,
        main: true,
      }
    ],
    storageProviders: [
      {
        id: 'builtin',
        type: 's3',
        config: {
          region: config.awsBucketRegion!,
          bucket: config.awsBucket!,
          accessKeyId: config.awsAccessKey!,
          secretAccessKey: config.awsSecretKey!,
        },
      }
    ],
    encrypt: config.encryptionKey,
    websocket: { server: wss },
    // A project's worker may run on this machine while developing.
    workerOptions: { allowLocalEndpoints: true },
  };

  devApp.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });

  devApp.use('/streamby', express.json(), createStreamByRouter(streambyConfig));

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${config.port} is already in use. Set a different PORT in .env`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(config.port, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:' + config.port + '/streamby');
    console.log('🔌 WebSocket available at ws://localhost:' + config.port + '/streamby/ws');
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

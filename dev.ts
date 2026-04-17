import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { StreamByConfig } from './src/types';
import { createStreamByRouter } from './src/middleware/createRouter';

dotenv.config();

const config = {
  port: process.env.PORT || 4000,
  dummyId: process.env.DUMMY_ID,
  awsSecret: process.env.AWS_SECRET,
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

  devApp.use(cors({
    origin: 'http://localhost:5173',
    credentials: true
  }));

  const streambyConfig: StreamByConfig = {
    authProvider: async (req) => {
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
    websocket: {
      server,
      path: '/streamby/ws',
    },
  };

  devApp.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });

  devApp.use('/streamby', express.json(), createStreamByRouter(streambyConfig));

  server.listen(config.port, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:' + config.port + '/streamby');
    console.log('🔌 WebSocket available at ws://localhost:' + config.port + '/streamby/ws');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

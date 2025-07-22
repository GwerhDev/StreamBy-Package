import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { registerModel } from './src/models/manager';
import { StreamByConfig } from './src/types';
import { initConnections } from './src/adapters/database/connectionManager';
import { dummyAuthProvider } from './src/services/auth';
import { createStreamByRouter } from './src/middleware/createRouter';

dotenv.config();

const config = {
  awsSecret: process.env.AWS_SECRET,
  awsBucket: process.env.AWS_BUCKET,
  awsAccessKey: process.env.AWS_ACCESS_KEY,
  awsSecretKey: process.env.AWS_SECRET_KEY,
  awsBucketRegion: process.env.AWS_BUCKET_REGION,
  mongoUri: process.env.MONGO_URI,
  postgresUri: process.env.POSTGRES_URI,
};

async function main() {
  const devApp = express();

  devApp.use(cors({
    origin: 'http://localhost:5173',
    credentials: true
  }));

  const streambyConfig: StreamByConfig = {
    authProvider: {
      userId: process.env.DUMMY_ID || '',
      username: 'dev-user',
      role: 'admin'
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
    ]
  };

  await initConnections(streambyConfig.databases || []);

  registerModel('Project', ['mongo', 'postgres'], 'projects');
  registerModel('Export', ['mongo', 'postgres'], 'exports');

  devApp.use('/streamby', express.json(), createStreamByRouter(streambyConfig));

  devApp.listen(4000, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:4000/streamby');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

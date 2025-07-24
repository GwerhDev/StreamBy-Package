import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { StreamByConfig } from './src/types';
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
    authProvider: async (req) => {
      return {
        userId: process.env.DUMMY_ID || 'dummy-user-id',
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
    ]
  };

  devApp.use('/streamby', express.json(), createStreamByRouter(streambyConfig));

  devApp.listen(4000, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:4000/streamby');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

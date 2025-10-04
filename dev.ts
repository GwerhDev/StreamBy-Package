import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { StreamByConfig } from './src/types';
import { createStreamByRouter } from './src/middleware/createRouter';
import { setEncryptionKey } from './src/utils/encryption';

dotenv.config();

const config = {
  awsSecret: process.env.AWS_SECRET,
  awsBucket: process.env.AWS_BUCKET,
  awsAccessKey: process.env.AWS_ACCESS_KEY,
  awsSecretKey: process.env.AWS_SECRET_KEY,
  awsBucketRegion: process.env.AWS_BUCKET_REGION,
  mongoUri: process.env.MONGO_URI,
  postgresUri: process.env.POSTGRES_URI,
  // For API credential encryption. Must be a 32-byte (64 hex characters) string.
  encryptionKey: process.env.STREAMBY_ENCRYPTION_KEY,
};

if (config.encryptionKey) {
  setEncryptionKey(config.encryptionKey);
} else {
  console.warn('STREAMBY_ENCRYPTION_KEY is not set. API credential encryption/decryption will be disabled.');
}

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

  devApp.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });

  devApp.use('/streamby', express.json(), createStreamByRouter(streambyConfig));

  devApp.listen(8080, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:8080/streamby');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});
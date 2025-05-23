import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { createDevServer } from './src/dev/server';
import { dummyAuthProvider } from './src/services/auth';

dotenv.config();

const config = {
  awsSecret: process.env.AWS_SECRET,
  awsBucket: process.env.AWS_BUCKET,
  awsAccessKey: process.env.AWS_ACCESS_KEY,
  awsSecretKey: process.env.AWS_SECRET_KEY,
  awsBucketRegion: process.env.AWS_BUCKET_REGION,
  mongodbString: process.env.MONGODB_STRING,
};

async function main() {
  const devApp = express();

  const streamByApp = createDevServer({
    authProvider: dummyAuthProvider,
    databases: [
      {
        dbType: 'mongo',
        connectionString: config.mongodbString!,
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
  });

  devApp.use(cors({
    origin: 'http://localhost:5173',
    credentials: true
  }));

  devApp.use('/streamby', streamByApp);

  devApp.listen(4000, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:4000/streamby');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import { createStreamByApp } from './src/index';
import { initProjectModel } from './src/db/initProjectModel';
import { createMongoProjectProvider } from './src/providers/mongoProjectProvider';
import { createS3Adapter } from './src/adapters/s3';
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
  await mongoose.connect(config.mongodbString!);
  const connection = mongoose.connection;

  const ProjectModel = initProjectModel(connection);

  const adapter = createS3Adapter({
    region: config.awsBucketRegion!,
    bucket: config.awsBucket!,
    accessKeyId: config.awsAccessKey!,
    secretAccessKey: config.awsSecretKey!,
  });

  const devApp = express();

  const streamByApp = createStreamByApp({
    authProvider: dummyAuthProvider,
    projectProvider: createMongoProjectProvider(ProjectModel, adapter),
    storageProvider: {
      type: 's3',
      config: {
        region: config.awsBucketRegion!,
        bucket: config.awsBucket!,
        accessKeyId: config.awsAccessKey!,
        secretAccessKey: config.awsSecretKey!,
      },
    },
    adapter,
  });

  devApp.use(cors({
    origin: 'http://localhost:5173',
    credentials: true
  }));

  devApp.use('/streamby', streamByApp);

  devApp.listen(4000, () => {
    console.log('🟢 StreamBy-core dev server listening on http://localhost:4000/');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

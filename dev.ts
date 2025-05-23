import dotenv from 'dotenv';
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
  // 1. Conexión a MongoDB
  await mongoose.connect(config.mongodbString!);
  const connection = mongoose.connection;

  // 2. Inicializar modelo
  const ProjectModel = initProjectModel(connection);

  // 3. Crear adaptador S3
  const adapter = createS3Adapter({
    region: config.awsBucketRegion!,
    bucket: config.awsBucket!,
    accessKeyId: config.awsAccessKey!,
    secretAccessKey: config.awsSecretKey!,
  });

  // 4. Crear app
  const app = createStreamByApp({
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

  // 5. Iniciar servidor
  app.listen(4000, () => {
    console.log('🟢 StreamBy-core listening on http://localhost:4000');
  });
}

main().catch((err) => {
  console.error('❌ Error starting server:', err);
});

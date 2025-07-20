import dotenv from 'dotenv';

dotenv.config();

export const config = {
  s3: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    region: process.env.AWS_REGION || 'us-east-1',
    bucketName: process.env.AWS_BUCKET_NAME || 'streamby-dev',
  },
  gcs: {
    projectId: process.env.GCS_PROJECT_ID || '',
    keyFilename: process.env.GCS_KEY_FILENAME || '',
    bucketName: process.env.GCS_BUCKET_NAME || 'streamby-dev',
  },
  local: {
    storagePath: process.env.LOCAL_STORAGE_PATH || './uploads',
  },
  mongooseString: process.env.MONGOOSE_STRING || '',
  prismaString: process.env.PRISMA_STRING || '',
};
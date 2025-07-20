import dotenv from 'dotenv';

dotenv.config();

export const config = {
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/streamby',
  jwtSecret: process.env.JWT_SECRET || 'supersecretjwtkey',
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
  supabaseString: process.env.SUPABASE_STRING || '',
};
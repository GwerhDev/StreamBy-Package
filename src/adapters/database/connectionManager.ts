import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { ensureCollectionsExist } from './nosql';
import { DatabaseCredential } from '../../types';

const connectedClients: { id: string, type: 'sql' | 'nosql', client: Pool | MongoClient }[] = [];

export const initConnections = async (configs: DatabaseCredential[]) => {
  for (const config of configs) {
    if (!config.connectionString) {
      console.error(`❌ Connection string not provided for database config with ID: ${config.id}. Skipping connection.`);
      continue;
    }
    try {
      if (config.type === 'sql') {
        const pool = new Pool({ connectionString: config.connectionString });
        await pool.connect();
        connectedClients.push({ id: config.id, type: 'sql', client: pool });
        console.log(`🟢 PostgreSQL connection established for ID: ${config.id}`);
        await ensureTablesExist(pool);
      } else if (config.type === 'nosql') {
        const client = new MongoClient(config.connectionString);
        await client.connect();
        connectedClients.push({ id: config.id, type: 'nosql', client: client });
        console.log(`🟢 MongoDB connection established for ID: ${config.id}`);
        await ensureCollectionsExist(client);
      }
    } catch (error) {
      console.error(`❌ Failed to establish ${config.type} connection for ID: ${config.id}. Error:`, error);
    }
  }
};

export const getConnection = (id: string) => {
  const clientEntry = connectedClients.find(c => c.id === id);
  if (!clientEntry) {
    throw new Error(`Connection with id ${id} not found.`);
  }
  return clientEntry;
};

const ensureTablesExist = async (pool: Pool) => {
  try {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS streamby;
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE IF NOT EXISTS streamby.projects (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        image TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✅ "projects" table ensured to exist.');

    // Ensure dbType column exists and is correctly configured
    await pool.query(`
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "dbType" VARCHAR(50);
    `);
    await pool.query(`
      UPDATE streamby.projects SET "dbType" = 'nosql' WHERE "dbType" IS NULL;
    `);
    await pool.query(`
      ALTER TABLE streamby.projects ALTER COLUMN "dbType" SET NOT NULL;
    `);
    await pool.query(`
      ALTER TABLE streamby.projects ALTER COLUMN "dbType" SET DEFAULT 'nosql';
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.exports (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "projectId" UUID NOT NULL REFERENCES streamby.projects(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        "filePath" TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✅ "exports" table ensured to exist.');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.project_members (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "projectId" UUID NOT NULL REFERENCES streamby.projects(id) ON DELETE CASCADE,
        "userId" VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL DEFAULT 'member',
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        "archivedBy" VARCHAR(255),
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE ("projectId", "userId")
      );
    `);
    console.log('✅ "project_members" table ensured to exist.');
  } catch (error) {
    console.error('❌ Error ensuring tables exist:', error);
  }
};

export const getConnectedIds = (): string[] => {
  return connectedClients.map(c => c.id);
};

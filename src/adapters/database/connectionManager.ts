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

// StreamBy's tables, made (or brought up to date) at startup. Several instances starting at once
// against the same database would deadlock on these statements, so one runs them at a time:
// in a transaction holding a transaction-level advisory lock, which ends with it. (A session
// lock could outlive its unlock behind a pooler in transaction mode, such as Supabase's, which
// may run the unlock on another connection, and block every later startup.)
const ensureTablesExist = async (pool: Pool) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('streamby:ensure-tables'))`);
    await createTables(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const createTables = async (pool: Pick<Pool, 'query'>) => {
  try {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS streamby;
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // Migrate id column from UUID to TEXT if it was created with the old schema
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE streamby.projects ALTER COLUMN id TYPE TEXT USING id::text;
        ALTER TABLE streamby.projects ALTER COLUMN id SET DEFAULT uuid_generate_v4()::text;
      EXCEPTION WHEN OTHERS THEN NULL; END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.projects (
        id               TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
        name             VARCHAR(255) NOT NULL,
        description      TEXT,
        image            TEXT,
        "allowedOrigin"  JSONB DEFAULT '[]',
        exports          JSONB DEFAULT '[]',
        connections      JSONB DEFAULT '[]',
        "dbConnections"  JSONB DEFAULT '[]',
        "dbType"         VARCHAR(50) NOT NULL DEFAULT 'sql',
        "createdAt"      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✅ "projects" table ensured to exist.');

    // Add JSONB columns to existing tables that predate this schema version
    await pool.query(`
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "allowedOrigin"     JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS exports             JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS connections         JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "dbConnections"     JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "storageConnections" JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS workflow            JSONB;
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS pipelines           JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "builtinBackfilledAt" TIMESTAMP WITH TIME ZONE;
      -- Written when a project is made (routes/project) and by its connection routes.
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS public              BOOLEAN DEFAULT TRUE;
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS category            TEXT;
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "integrationConnections"  JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "distributionConnections" JSONB DEFAULT '[]';
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "renderFarmConnections"   JSONB DEFAULT '[]';
    `);

    // Ensure dbType exists with a non-null default
    await pool.query(`
      ALTER TABLE streamby.projects ADD COLUMN IF NOT EXISTS "dbType" VARCHAR(50) NOT NULL DEFAULT 'sql';
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.project_members (
        id           TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
        "projectId"  TEXT NOT NULL REFERENCES streamby.projects(id) ON DELETE CASCADE,
        "userId"     VARCHAR(255) NOT NULL,
        role         VARCHAR(255) NOT NULL DEFAULT 'member',
        status       VARCHAR(50) NOT NULL DEFAULT 'active',
        archived     BOOLEAN NOT NULL DEFAULT FALSE,
        "archivedBy" VARCHAR(255),
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt"  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE ("projectId", "userId")
      );
    `);

    await pool.query(`
      ALTER TABLE streamby.project_members ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active';
    `);
    console.log('✅ "project_members" table ensured to exist.');

    // Migrate projectId FK column from UUID to TEXT if table predates this schema version
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE streamby.project_members DROP CONSTRAINT IF EXISTS project_members_projectId_fkey;
        ALTER TABLE streamby.project_members ALTER COLUMN "projectId" TYPE TEXT;
        ALTER TABLE streamby.project_members ADD CONSTRAINT project_members_projectid_fkey
          FOREIGN KEY ("projectId") REFERENCES streamby.projects(id) ON DELETE CASCADE;
      EXCEPTION WHEN OTHERS THEN NULL; END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.exports (
        id          TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
        "projectId" TEXT NOT NULL REFERENCES streamby.projects(id) ON DELETE CASCADE,
        status      VARCHAR(50) NOT NULL DEFAULT 'pending',
        "filePath"  TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✅ "exports" table ensured to exist.');

    // user_integrations is registered against the main db only (see createRouter.ts), but
    // this function runs per-SQL-connection like projects/exports above — harmless on
    // non-main connections since the model never queries them there.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.user_integrations (
        id                     TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
        "userId"               VARCHAR(255) NOT NULL,
        kind                   VARCHAR(20) NOT NULL,
        provider               VARCHAR(20) NOT NULL,
        name                   VARCHAR(255) NOT NULL,
        description            TEXT,
        "encryptedCredential"  TEXT NOT NULL,
        "createdAt"            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "updatedAt"            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS user_integrations_userid_idx ON streamby.user_integrations ("userId");
    `);
    console.log('✅ "user_integrations" table ensured to exist.');

    // API tokens: only their hash is kept (see services/apiTokens). Main db only, like
    // user_integrations above. A table from before tokens had a kind and permissions gets the
    // new columns; its old tokens no longer work (they have no kind) and aren't listed.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.api_tokens (
        id                TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
        kind              VARCHAR(10),
        "userId"          VARCHAR(255) NOT NULL,
        "createdByName"   VARCHAR(255),
        name              VARCHAR(255) NOT NULL,
        prefix            VARCHAR(32) NOT NULL,
        hash              CHAR(64) NOT NULL UNIQUE,
        permissions       JSONB NOT NULL DEFAULT '[]',
        "projectIds"      JSONB NOT NULL,
        "createdAt"       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        "expiresAt"       TIMESTAMP WITH TIME ZONE,
        "lastUsedAt"      TIMESTAMP WITH TIME ZONE
      );
      ALTER TABLE streamby.api_tokens ADD COLUMN IF NOT EXISTS kind VARCHAR(10);
      ALTER TABLE streamby.api_tokens ADD COLUMN IF NOT EXISTS "createdByName" VARCHAR(255);
      ALTER TABLE streamby.api_tokens ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'streamby' AND table_name = 'api_tokens' AND column_name = 'access') THEN
          ALTER TABLE streamby.api_tokens ALTER COLUMN access DROP NOT NULL;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS api_tokens_userid_idx ON streamby.api_tokens ("userId");
      CREATE INDEX IF NOT EXISTS api_tokens_kind_idx ON streamby.api_tokens (kind);
    `);
    console.log('✅ "api_tokens" table ensured to exist.');

    // Jobs (see services/jobStore): kept here so they survive restarts and every instance sees
    // them. Main db only, like the tables above.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.jobs (
        id               TEXT PRIMARY KEY,
        "jobType"        VARCHAR(40) NOT NULL,
        "userId"         VARCHAR(255) NOT NULL,
        "projectId"      VARCHAR(255) NOT NULL,
        "assetId"        VARCHAR(255),
        status           VARCHAR(20) NOT NULL,
        stage            VARCHAR(60) NOT NULL,
        progress         INTEGER NOT NULL DEFAULT 0,
        payload          JSONB NOT NULL DEFAULT '{}',
        error            TEXT,
        worker           JSONB,
        kind             VARCHAR(100),
        profile          JSONB,
        "versionId"      VARCHAR(255),
        "resultMode"     VARCHAR(20),
        attempts         INTEGER NOT NULL DEFAULT 0,
        "maxAttempts"    INTEGER NOT NULL DEFAULT 1,
        "nextAttemptAt"  TIMESTAMP WITH TIME ZONE,
        "leaseUntil"     TIMESTAMP WITH TIME ZONE,
        "callbackHash"   CHAR(64),
        upload           JSONB,
        report           JSONB,
        result           JSONB,
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS jobs_project_idx ON streamby.jobs ("projectId", "createdAt");
      CREATE INDEX IF NOT EXISTS jobs_due_idx ON streamby.jobs (status, "nextAttemptAt") WHERE worker IS NOT NULL;
    `);
    console.log('✅ "jobs" table ensured to exist.');

    // The MCP server's audit log: every tool call (see mcp/audit). Main db only.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streamby.mcp_audit (
        id            TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
        "userId"      VARCHAR(255) NOT NULL,
        "tokenId"     VARCHAR(255) NOT NULL,
        "projectId"   VARCHAR(255),
        tool          VARCHAR(100) NOT NULL,
        ok            BOOLEAN NOT NULL,
        status        INTEGER,
        error         TEXT,
        "durationMs"  INTEGER NOT NULL,
        "createdAt"   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS mcp_audit_token_idx ON streamby.mcp_audit ("tokenId", "createdAt");
    `);
    console.log('✅ "mcp_audit" table ensured to exist.');
  } catch (error) {
    console.error('❌ Error ensuring tables exist:', error);
  }
};

export const getConnectedIds = (): string[] => {
  return connectedClients.map(c => c.id);
};

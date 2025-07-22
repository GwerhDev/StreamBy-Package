
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { DatabaseCredential } from '../types';

const clients: { [key: string]: Pool | MongoClient } = {};

export const initConnections = async (configs: DatabaseCredential[]) => {
  for (const config of configs) {
    if (!config.connectionString) {
      throw new Error(`Connection string not provided for database config with id ${config.id}`);
    }
    if (config.type === 'sql') {
      const pool = new Pool({ connectionString: config.connectionString });
      await pool.connect();
      clients[config.id] = pool;
      console.log(`🟢 PostgreSQL connection established for ID: ${config.id}`);
    } else if (config.type === 'nosql') {
      const client = new MongoClient(config.connectionString);
      await client.connect();
      clients[config.id] = client;
      console.log(`🟢 MongoDB connection established for ID: ${config.id}`);
    }
  }
};

export const getConnection = (id: string) => {
  const client = clients[id];
  if (!client) {
    throw new Error(`Connection with id ${id} not found.`);
  }
  return client;
};

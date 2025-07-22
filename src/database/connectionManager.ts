
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';

type ConnectionConfig = {
  id: string;
  type: 'postgres' | 'mongodb';
  connectionString: string;
};

const clients: { [key: string]: Pool | MongoClient } = {};

export const initConnections = async (configs: ConnectionConfig[]) => {
  for (const config of configs) {
    if (config.type === 'postgres') {
      const pool = new Pool({ connectionString: config.connectionString });
      await pool.connect();
      clients[config.id] = pool;
    } else if (config.type === 'mongodb') {
      const client = new MongoClient(config.connectionString);
      await client.connect();
      clients[config.id] = client;
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

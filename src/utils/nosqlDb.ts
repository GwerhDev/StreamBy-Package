import { MongoClient } from 'mongodb';
import { getConnection, getConnectedIds } from '../adapters/database/connectionManager';

/** The NoSQL database the project's files and production live in, or null when there's none. */
export function nosqlDb() {
  const ids = getConnectedIds().filter(id => getConnection(id).type === 'nosql');
  if (!ids.length) return null;
  return (getConnection(ids[0]).client as MongoClient).db();
}

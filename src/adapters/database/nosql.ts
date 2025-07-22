import { MongoClient, Document } from 'mongodb';

export const nosqlAdapter = {
  find: async <T extends Document>(connection: MongoClient, tableName: string, filter: any): Promise<T[]> => {
    const db = connection.db();
    const result = await db.collection<T>(tableName).find(filter).toArray();
    return result as T[];
  },

  findOne: async <T extends Document>(connection: MongoClient, tableName: string, filter: any): Promise<T | null> => {
    const db = connection.db();
    const result = await db.collection<T>(tableName).findOne(filter);
    return result as T | null;
  },

  create: async <T extends Document>(connection: MongoClient, tableName: string, data: T): Promise<T> => {
    const db = connection.db();
    const result = await db.collection<T>(tableName).insertOne(data as any);
    return { ...data, _id: result.insertedId } as T;
  },

  update: async <T extends Document>(connection: MongoClient, tableName: string, filter: any, data: Partial<T>): Promise<T | null> => {
    const db = connection.db();
    const result = await db.collection<T>(tableName).findOneAndUpdate(filter, { $set: data }, { returnDocument: 'after' });
    if (!result) {
      return null;
    }
    return result.value ? result.value as T : null;
  },

  delete: async <T extends Document>(connection: MongoClient, tableName: string, filter: any): Promise<number> => {
    const db = connection.db();
    const result = await db.collection<T>(tableName).deleteMany(filter);
    return result.deletedCount;
  },
};

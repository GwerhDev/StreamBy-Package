import { MongoClient, Document, ObjectId } from 'mongodb';

export const ensureCollectionsExist = async (client: MongoClient) => {
  const db = client.db();

  // Ensure 'projects' collection exists and define its schema implicitly
  // Schema: { _id: ObjectId, name: string, description: string, dbType: string, createdAt: Date, updatedAt: Date, members: [{ userId: string, archived: boolean }] }
  const projectsCollection = db.collection('projects');
  await projectsCollection.findOne({}); // Attempt to find one to ensure collection is created if it doesn't exist
  console.log('✅ "projects" collection ensured to exist.');

  // Ensure 'exports' collection exists and define its schema implicitly
  // Schema: { _id: ObjectId, projectId: ObjectId, status: string, filePath: string, createdAt: Date, updatedAt: Date }
  const exportsCollection = db.collection('exports');
  await exportsCollection.findOne({}); // Attempt to find one to ensure collection is created if it doesn't exist
  console.log('✅ "exports" collection ensured to exist.');
};

export const nosqlAdapter = {
  find: async (connection: MongoClient, tableName: string, filter: any): Promise<Document[]> => {
    const db = connection.db();
    const result = await db.collection(tableName).find(filter).toArray();
    return result;
  },

  findOne: async (connection: MongoClient, tableName: string, filter: any): Promise<Document | null> => {
    const db = connection.db();
    let processedFilter = { ...filter };
    if (processedFilter._id && typeof processedFilter._id === 'string') {
      processedFilter._id = new ObjectId(processedFilter._id);
    }
    const result = await db.collection(tableName).findOne(processedFilter);
    return result;
  },

  create: async <T extends Document>(connection: MongoClient, tableName: string, data: T): Promise<T> => {
    const db = connection.db();
    const result = await db.collection<T>(tableName).insertOne(data as any);
    return { ...data, _id: result.insertedId } as T;
  },

  update: async (connection: MongoClient, tableName: string, filter: any, data: Partial<Document>): Promise<Document | null> => {
    const db = connection.db();
    let processedFilter = { ...filter };
    if (processedFilter._id && typeof processedFilter._id === 'string') {
      processedFilter._id = new ObjectId(processedFilter._id);
    }
    const result = await db.collection(tableName).findOneAndUpdate(processedFilter, { $set: data }, { returnDocument: 'after' });
    if (!result) {
      return null;
    }
    return result;
  },

  delete: async (connection: MongoClient, tableName: string, filter: any): Promise<number> => {
    const db = connection.db();
    let processedFilter = { ...filter };
    if (processedFilter._id && typeof processedFilter._id === 'string') {
      processedFilter._id = new ObjectId(processedFilter._id);
    }
    const result = await db.collection(tableName).deleteMany(processedFilter);
    return result.deletedCount;
  },
};

import { MongoClient, Document, ObjectId, UpdateFilter } from 'mongodb';
import { FieldDefinition, NodeSchema } from '../../types';

export const ensureCollectionsExist = async (client: MongoClient) => {
  const db = client.db();

  await db.collection('projects').findOne({});
  console.log('✅ "projects" collection ensured to exist.');

  await db.collection('exports').findOne({});
  console.log('✅ "exports" collection ensured to exist.');

  await db.collection('records').findOne({});
  console.log('✅ "records" collection ensured to exist.');

  await db.collection('_tables').findOne({});
  console.log('✅ "_tables" collection ensured to exist.');
};

export const createNoSQLExportCollection = async (
  connection: MongoClient,
  projectId: string,
  exportName: string,
  method: string,
  nodeSchema?: NodeSchema,
): Promise<{ exportId: string }> => {
  const db = connection.db();
  const result = await db.collection('exports').insertOne({
    projectId,
    name: exportName,
    method,
    nodeSchema,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { exportId: result.insertedId.toHexString() };
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

  update: async (connection: MongoClient, tableName: string, filter: any, data: Document | Partial<Document>): Promise<Document | null> => {
    const db = connection.db();
    let processedFilter = { ...filter };
    if (processedFilter._id && typeof processedFilter._id === 'string') {
      processedFilter._id = new ObjectId(processedFilter._id);
    }

    // Check if the update data contains MongoDB update operators (e.g., $set, $push)
    const isUpdateOperator = Object.keys(data).some(key => key.startsWith('$'));
    const updateDocument = isUpdateOperator ? data : { $set: data };

    const result = await db.collection(tableName).findOneAndUpdate(processedFilter, updateDocument, { returnDocument: 'after' });
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
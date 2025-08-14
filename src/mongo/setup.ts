import { SetupStreambyMongoOptions } from '../config/types';

export async function setupStreambyMongo({
    client,
    dbName = 'streamby',
}: SetupStreambyMongoOptions): Promise<void> {
    const db = client.db(dbName);

    // Create collections if they don't exist. createCollection is idempotent.
    // It will not recreate the collection if it already exists.
    await db.createCollection('projects');
    await db.createCollection('assets');

    // Create indexes idempotently. createIndex will not recreate if an index
    // with the same key and options already exists.

    // projects collection indexes
    // { name: 1 } (unique opcional si aplica) - starting with non-unique as it's safer
    await db.collection('projects').createIndex({ name: 1 });

    // assets collection indexes
    await db.collection('assets').createIndex({ projectId: 1 });
    await db.collection('assets').createIndex({ path: 1 });

    console.log(`MongoDB setup complete for database: ${dbName}`);
}

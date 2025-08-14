import { MongoClient } from 'mongodb';
import { setupStreambyMongo } from '../src/mongo/setup';
import { afterEach, beforeAll, afterAll, describe, it, expect } from 'vitest';

describe('setupStreambyMongo', () => {
    let client: MongoClient;
    const uri = 'mongodb://localhost:27017';

    beforeAll(async () => {
        client = new MongoClient(uri);
        await client.connect();
    });

    afterAll(async () => {
        await client.close();
    });

    afterEach(async () => {
        // Clean up any databases created during tests
        const dbs = await client.db().admin().listDatabases();
        for (const dbInfo of dbs.databases) {
            if (dbInfo.name.startsWith('test_streamby_db_')) {
                await client.db(dbInfo.name).dropDatabase();
            }
        }
    });

    it('should create collections and indexes idempotently', async () => {
        const dbName = `test_streamby_db_${Date.now()}`;

        // First setup
        await setupStreambyMongo({ client, dbName });

        const db = client.db(dbName);

        // Verify collections exist
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        expect(collectionNames).toContain('projects');
        expect(collectionNames).toContain('assets');

        // Verify indexes on projects collection
        const projectIndexes = await db.collection('projects').indexes();
        const projectIndexNames = projectIndexes.map(idx => idx.name);
        expect(projectIndexNames).toContain('_id_'); // Default index
        expect(projectIndexNames).toContain('name_1'); // Custom index

        // Verify indexes on assets collection
        const assetIndexes = await db.collection('assets').indexes();
        const assetIndexNames = assetIndexes.map(idx => idx.name);
        expect(assetIndexNames).toContain('_id_'); // Default index
        expect(assetIndexNames).toContain('projectId_1'); // Custom index
        expect(assetIndexNames).toContain('path_1'); // Custom index

        // Call setup again (idempotency check)
        await setupStreambyMongo({ client, dbName });

        // Verify collections and indexes still exist and no duplicates
        const collectionsAfter = await db.listCollections().toArray();
        const collectionNamesAfter = collectionsAfter.map(c => c.name);
        expect(collectionNamesAfter).toContain('projects');
        expect(collectionNamesAfter).toContain('assets');
        expect(collectionsAfter.length).toBe(collectionNames.length); // No new collections

        const projectIndexesAfter = await db.collection('projects').indexes();
        expect(projectIndexesAfter.length).toBe(projectIndexes.length); // No new indexes

        const assetIndexesAfter = await db.collection('assets').indexes();
        expect(assetIndexesAfter.length).toBe(assetIndexes.length); // No new indexes
    }, 20000); // Increased timeout for DB operations
});

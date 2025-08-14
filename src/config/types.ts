import { Pool } from 'pg';
import { MongoClient } from 'mongodb';

export interface SetupStreambyPgOptions {
    pool: Pool;
    schema?: string;
    reset?: boolean;
    allowResetInProd?: boolean; // NEW
}

export interface SetupStreambyMongoOptions {
    client: MongoClient;
    dbName?: string;
}

export interface SetupResult {
    didCreateSchema: boolean;
    didCreateTables: boolean;
    didReset: boolean;
    errors?: string[];
}

import { Model } from './Model';

const models: { [key: string]: Model<any> } = {};

export const defineModel = (name: string, connectionIds: string[], tableName: string, schema?: string) => {
  models[name] = new Model(connectionIds, tableName, schema);
};

export const getModel = (name: string, dbType?: string, schema?: string): Model<any> => {
  const model = models[name];
  if (!model) {
    throw new Error(`Model ${name} not defined.`);
  }
  // If a schema is provided, create a new Model instance with the specified schema
  if (schema) {
    return new Model(model.getConnectionIds(), model.getTableName(), schema); // Use getters
  }
  if (dbType) {
    return model.useDbType(dbType);
  }
  return model;
};


import { Model } from './Model';

const models: { [key: string]: Model<any> } = {};

export const defineModel = (name: string, connectionIds: string[], tableName: string, schema?: string) => {
  models[name] = new Model(connectionIds, tableName, schema);
};

export const getModel = (name: string, dbType?: string): Model<any> => {
  const model = models[name];
  if (!model) {
    throw new Error(`Model ${name} not defined.`);
  }
  if (dbType) {
    return model.useDbType(dbType);
  }
  return model;
};

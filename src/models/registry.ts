
import { Model } from './Model';

const models: { [key: string]: Model<any> } = {};

export const defineModel = (name: string, connectionIds: string[], tableName: string) => {
  models[name] = new Model(connectionIds, tableName);
};

export const getModel = (name: string): Model<any> => {
  const model = models[name];
  if (!model) {
    throw new Error(`Model ${name} not defined.`);
  }
  return model;
};

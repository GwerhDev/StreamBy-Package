
import { Model } from './Model';

const models: { [key: string]: Model<any> } = {};

export const defineModel = (name: string, connectionId: string, tableName: string) => {
  models[name] = new Model(connectionId, tableName);
};

export const getModel = (name: string): Model<any> => {
  const model = models[name];
  if (!model) {
    throw new Error(`Model ${name} not defined.`);
  }
  return model;
};

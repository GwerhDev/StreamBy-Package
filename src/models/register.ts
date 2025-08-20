import { defineModel } from './registry';

export const registerModel = (name: string, connectionIds: string[], tableName: string, schema?: string) => {
  defineModel(name, connectionIds, tableName, schema);
};

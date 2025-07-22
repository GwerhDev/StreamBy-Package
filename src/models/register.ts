import { defineModel } from './registry';

export const registerModel = (name: string, connectionId: string, tableName: string) => {
  defineModel(name, connectionId, tableName);
};

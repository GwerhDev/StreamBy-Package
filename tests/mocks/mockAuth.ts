import { AuthProvider } from "../../src/types";

export const mockAuthProvider: AuthProvider = async (req) => {
  return {
    userId: 'test-user',
    projects: ['test-project'],
    role: 'admin',
  };
};

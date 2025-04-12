import { AuthProvider } from "../../src/types";

export const mockAuthProvider: AuthProvider = async (req) => ({
  userId: 'test-user',
  projectId: 'test-project',
  role: 'admin'
});
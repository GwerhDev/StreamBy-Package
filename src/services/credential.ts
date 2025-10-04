import { getModel } from '../models/manager';
import { StreamByConfig, Credential, ProjectInfo } from '../types';
import { encrypt, isEncryptionKeySet } from '../utils/encryption';
import { ObjectId } from 'mongodb';

export async function addCredential(
  config: StreamByConfig,
  projectId: string,
  newCredential: Omit<Credential, 'encryptedValue'> & { value: string }
): Promise<ProjectInfo> {
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot add credentials.');
  }

  const ProjectModel = getModel('projects', 'nosql');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) {
    throw new Error('Project not found.');
  }

  const encryptedValue = encrypt(newCredential.value);
  const credentialToSave: Credential = {
    id: newCredential.id || new ObjectId().toHexString(), // Generate ID if not provided
    key: newCredential.key,
    encryptedValue: encryptedValue,
  };

  const updatedProject = await ProjectModel.update(
    { _id: projectId },
    { $push: { credentials: credentialToSave } }
  );

  if (!updatedProject) {
    throw new Error('Failed to add credential to project.');
  }

  return updatedProject as ProjectInfo;
}

export async function updateCredential(
  config: StreamByConfig,
  projectId: string,
  credentialId: string,
  updates: Partial<Omit<Credential, 'encryptedValue'> & { value: string }>
): Promise<ProjectInfo> {
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot update credentials.');
  }

  const ProjectModel = getModel('projects', 'nosql');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) {
    throw new Error('Project not found.');
  }

  const credentialIndex = project.credentials?.findIndex(cred => cred.id === credentialId);

  if (credentialIndex === undefined || credentialIndex === -1) {
    throw new Error(`Credential with ID ${credentialId} not found.`);
  }

  const currentCredential = project.credentials![credentialIndex];
  let encryptedValue = currentCredential.encryptedValue;

  if (updates.value !== undefined) {
    encryptedValue = encrypt(updates.value);
  }

  const updatedCredential: Credential = {
    ...currentCredential,
    key: updates.key || currentCredential.key,
    encryptedValue: encryptedValue,
  };

  const updatedProject = await ProjectModel.update(
    { _id: projectId, 'credentials.id': credentialId },
    { $set: { 'credentials.$': updatedCredential } }
  );

  if (!updatedProject) {
    throw new Error('Failed to update credential in project.');
  }

  return updatedProject as ProjectInfo;
}

export async function deleteCredential(
  config: StreamByConfig,
  projectId: string,
  credentialId: string
): Promise<ProjectInfo> {
  const ProjectModel = getModel('projects', 'nosql');
  const project = await ProjectModel.findOne({ _id: projectId }) as ProjectInfo;

  if (!project) {
    throw new Error('Project not found.');
  }

  const updatedProject = await ProjectModel.update(
    { _id: projectId },
    { $pull: { credentials: { id: credentialId } } }
  );

  if (!updatedProject) {
    throw new Error('Failed to delete credential from project.');
  }

  return updatedProject as ProjectInfo;
}

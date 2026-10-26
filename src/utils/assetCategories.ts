// The categories assets are kept in, and what each one takes.

export type StorageCategory = 'images' | 'audios' | 'videos' | '3d-models';

export const VALID_CATEGORIES: StorageCategory[] = ['images', 'audios', 'videos', '3d-models'];
const VALID_3D_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply']);

/** Whether a file (its content type, or for 3D models its extension) belongs in a category. */
export function validateContentType(contentType: string, filename: string, category: StorageCategory): boolean {
  if (category === 'images') return contentType.startsWith('image/');
  if (category === 'audios') return contentType.startsWith('audio/');
  if (category === 'videos') return contentType.startsWith('video/');
  if (category === '3d-models') {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ext ? VALID_3D_EXTENSIONS.has(`.${ext}`) : false;
  }
  return false;
}

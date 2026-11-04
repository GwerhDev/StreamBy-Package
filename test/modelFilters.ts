// What a model's find asks for, besides fields equal (see Model.find): for the tests' in-memory
// models, the same records the databases answer.
export function bounded(name: string, filter: any = {}): ((record: any) => boolean) | null {
  if (name === 'projects' && typeof filter.memberUserId === 'string') {
    return p => (p.members ?? []).some((m: any) => String(m.userId) === filter.memberUserId);
  }
  if (name === 'projects' && filter.listed === true) return p => p.public !== false;
  if (name === 'users' && typeof filter.usernameContains === 'string') {
    return u => String(u.username ?? '').toLowerCase().includes(filter.usernameContains.toLowerCase());
  }
  if (name === 'users' && Array.isArray(filter.ids)) return u => filter.ids.includes(String(u._id ?? u.id));
  return null;
}

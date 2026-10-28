// A MongoDB database in memory, with what the routes use of it: equality, $in, $exists and
// $or filters; $set, $unset and $pull updates (and upserts); find with sort and limit.

type Doc = Record<string, any>;

const valueMatches = (actual: any, expected: any): boolean => {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$in' in expected) return expected.$in.includes(actual);
    if ('$exists' in expected) return (actual !== undefined) === expected.$exists;
  }
  return actual === expected || (actual != null && expected != null && String(actual) === String(expected) && typeof expected !== 'object');
};

export const matches = (doc: Doc, filter: Doc = {}): boolean =>
  Object.entries(filter).every(([key, expected]) =>
    key === '$or' ? (expected as Doc[]).some(f => matches(doc, f)) : valueMatches(doc[key], expected));

export class FakeCollection {
  docs: Doc[] = [];

  find(filter: Doc = {}) {
    let result = this.docs.filter(d => matches(d, filter));
    const cursor = {
      sort: (by: Doc) => {
        const [[key, dir]] = Object.entries(by);
        result = [...result].sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0));
        return cursor;
      },
      limit: (n: number) => { result = result.slice(0, n); return cursor; },
      toArray: async () => result.map(d => ({ ...d })),
    };
    return cursor;
  }

  async findOne(filter: Doc = {}) {
    const found = this.docs.find(d => matches(d, filter));
    return found ? { ...found } : null;
  }

  async insertOne(doc: Doc) { this.docs.push({ ...doc }); return { insertedId: doc._id }; }

  async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    let doc = this.docs.find(d => matches(d, filter));
    if (!doc && options.upsert) {
      doc = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && (typeof v !== 'object' || v === null)));
      this.docs.push(doc);
    }
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
    for (const [key, cond] of Object.entries(update.$pull ?? {})) {
      doc[key] = (doc[key] ?? []).filter((item: Doc) => !matches(item, cond as Doc));
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  // The document it changed, as it is after (returnDocument 'after'), even if the change made
  // it no longer match the filter.
  async findOneAndUpdate(filter: Doc, update: Doc) {
    const doc = this.docs.find(d => matches(d, filter));
    if (!doc) return null;
    await this.updateOne(filter, update);
    return { ...doc };
  }

  async deleteOne(filter: Doc) {
    const i = this.docs.findIndex(d => matches(d, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }

  async deleteMany(filter: Doc) {
    const before = this.docs.length;
    this.docs = this.docs.filter(d => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }

  async countDocuments(filter: Doc = {}) { return this.docs.filter(d => matches(d, filter)).length; }
}

export class FakeDb {
  collections = new Map<string, FakeCollection>();
  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection());
    return this.collections.get(name)!;
  }
  docs(name: string) { return this.collection(name).docs; }
  reset() { this.collections.clear(); }
}

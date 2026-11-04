// A MongoDB database in memory, with what the routes use of it: equality (an array field matches
// a value it holds), $in, $exists and $or filters; $set, $unset, $inc, $max and $pull updates (and
// upserts), one document or many; find with sort, limit and projection; and unique indexes
// (partial ones too), a write that breaks one refused with a duplicate key error (code 11000).

type Doc = Record<string, any>;

const valueMatches = (actual: any, expected: any): boolean => {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$in' in expected) return expected.$in.includes(actual);
    if ('$exists' in expected) return (actual !== undefined) === expected.$exists;
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some(item => valueMatches(item, expected));
  return actual === expected || (actual != null && expected != null && String(actual) === String(expected) && typeof expected !== 'object');
};

export const matches = (doc: Doc, filter: Doc = {}): boolean =>
  Object.entries(filter).every(([key, expected]) =>
    key === '$or' ? (expected as Doc[]).some(f => matches(doc, f)) : valueMatches(doc[key], expected));

const applyUpdate = (doc: Doc, update: Doc) => {
  if (update.$set) Object.assign(doc, update.$set);
  for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
  for (const [key, by] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + (by as number);
  for (const [key, value] of Object.entries(update.$max ?? {})) if (doc[key] === undefined || (value as number) > doc[key]) doc[key] = value;
  for (const [key, cond] of Object.entries(update.$pull ?? {})) {
    const pulled = (item: any) => (cond && typeof cond === 'object' ? matches(item, cond as Doc) : item === cond);
    doc[key] = (doc[key] ?? []).filter((item: any) => !pulled(item));
  }
};

interface UniqueIndex { name: string; keys: string[]; partial?: Doc }

export class DuplicateKeyError extends Error {
  code = 11000;
  constructor(index: string) { super(`E11000 duplicate key error index: ${index}`); }
}

export class FakeCollection {
  docs: Doc[] = [];
  indexes: UniqueIndex[] = [];

  async createIndex(keys: Doc, options: { name?: string; unique?: boolean; partialFilterExpression?: Doc } = {}) {
    const name = options.name ?? Object.keys(keys).join('_');
    if (options.unique && !this.indexes.some(i => i.name === name)) {
      this.indexes.push({ name, keys: Object.keys(keys), partial: options.partialFilterExpression });
    }
    return name;
  }

  // The first unique index `doc` would break beside the others (`except`, itself as it was).
  private broken(doc: Doc, except?: Doc): string | null {
    for (const index of this.indexes) {
      if (index.partial && !matches(doc, index.partial)) continue;
      const clash = this.docs.some(other => other !== except && other !== doc
        && (!index.partial || matches(other, index.partial))
        && index.keys.every(k => other[k] === doc[k]));
      if (clash) return index.name;
    }
    return null;
  }

  find(filter: Doc = {}) {
    let result = this.docs.filter(d => matches(d, filter));
    const cursor = {
      sort: (by: Doc) => {
        // By each key in turn, the next one breaking ties.
        const keys = Object.entries(by);
        result = [...result].sort((a, b) => {
          for (const [key, dir] of keys) {
            if (a[key] > b[key]) return dir;
            if (a[key] < b[key]) return -dir;
          }
          return 0;
        });
        return cursor;
      },
      limit: (n: number) => { result = result.slice(0, n); return cursor; },
      // A projection keeps the fields asked for (1s only), as the routes use it.
      project: (fields: Doc) => {
        const keep = Object.keys(fields).filter(k => fields[k]);
        result = result.map(d => Object.fromEntries(keep.filter(k => k in d).map(k => [k, d[k]])));
        return cursor;
      },
      toArray: async () => result.map(d => ({ ...d })),
    };
    return cursor;
  }

  async findOne(filter: Doc = {}) {
    const found = this.docs.find(d => matches(d, filter));
    return found ? { ...found } : null;
  }

  async insertOne(doc: Doc) {
    const broken = this.broken(doc);
    if (broken) throw new DuplicateKeyError(broken);
    this.docs.push({ ...doc });
    return { insertedId: doc._id };
  }

  async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    let doc = this.docs.find(d => matches(d, filter));
    let upserted = false;
    if (!doc && options.upsert) {
      doc = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && (typeof v !== 'object' || v === null)));
      this.docs.push(doc);
      upserted = true;
    }
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    const before = { ...doc };
    applyUpdate(doc, update);
    const broken = this.broken(doc);
    if (broken) {
      if (upserted) this.docs.splice(this.docs.indexOf(doc), 1);
      else { for (const key of Object.keys(doc)) delete doc[key]; Object.assign(doc, before); }
      throw new DuplicateKeyError(broken);
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Doc, update: Doc) {
    const found = this.docs.filter(d => matches(d, filter));
    for (const doc of found) applyUpdate(doc, update);
    return { matchedCount: found.length, modifiedCount: found.length };
  }

  // The document it changed, as it is after (returnDocument 'after'), even if the change made
  // it no longer match the filter.
  async findOneAndUpdate(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    if (!this.docs.some(d => matches(d, filter)) && !options.upsert) return null;
    await this.updateOne(filter, update, options);
    return { ...this.docs.find(d => matches(d, filter)) ?? this.docs.at(-1)! };
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

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The PostgreSQL tests share one local database, and each starts StreamBy against it: its
    // startup statements lock tables another file's test is writing to, and they deadlock.
    fileParallelism: false,
  },
});

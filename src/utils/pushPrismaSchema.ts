
import { execSync } from 'child_process';
import path from 'path';

let schemaPushed = false;

/**
 * Executes `prisma db push` programmatically to sync the schema with the database.
 * Ensures the command is only run once per application lifecycle.
 */
export function pushPrismaSchema(): void {
  if (schemaPushed) {
    console.log('[StreamBy] Prisma schema has already been pushed. Skipping.');
    return;
  }

  try {
    // Resolve the path to the schema.prisma file relative to the compiled JS file.
    // __dirname will be /path/to/your/project/node_modules/streamby-core/dist/utils
    const schemaPath = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');
    
    console.log(`[StreamBy] Locating Prisma schema at: ${schemaPath}`);
    console.log('[StreamBy] Pushing Prisma schema to the database...');

    const command = `npx prisma db push --schema="${schemaPath}"`;
    execSync(command, { stdio: 'inherit' });

    console.log('[StreamBy] Prisma schema pushed successfully.');
    schemaPushed = true;
  } catch (error) {
    console.error('[StreamBy] Failed to push Prisma schema:', error);
    // Optional: decide if the application should exit on failure
    // process.exit(1);
  }
}

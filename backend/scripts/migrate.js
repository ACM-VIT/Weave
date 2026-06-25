import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required in .env');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function runMigrations() {
  try {
    const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');
    
    // Read all .sql files and sort them alphabetically
    const allFiles = fs.readdirSync(migrationsDir);
    const files = allFiles
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    
    console.log('Connecting to database...');
    
    // 1. Ensure our migration history table exists (makes this idempotent!)
    await sql`
      CREATE TABLE IF NOT EXISTS public.migration_history (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      if (!fs.existsSync(filePath)) {
        console.warn(`File ${file} not found, skipping.`);
        continue;
      }

      // 2. Check if this specific file has already been applied
      const existing = await sql`SELECT * FROM public.migration_history WHERE filename = ${file}`;
      if (existing.length > 0) {
        console.log(`Skipping ${file} - already applied.`);
        continue;
      }

      console.log(`Executing ${file}...`);
      const query = fs.readFileSync(filePath, 'utf8');
      
      // 3. Apply the SQL and record it in the history table
      await sql.begin(async (tx) => {
        await tx.unsafe(query);
        await tx`INSERT INTO public.migration_history (filename) VALUES (${file})`;
      });

      console.log(`Successfully applied ${file}.`);
    }
    
    console.log('\nAll migrations completed successfully!');
    
  } catch (err) {
    console.error('\nMigration failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

runMigrations();

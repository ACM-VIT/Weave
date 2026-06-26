import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing in environment variables');
}

export default defineConfig({
  schema: './db/schema.ts',
  out: '../database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
});

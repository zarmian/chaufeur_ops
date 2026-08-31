import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Where the CLI finds the database.
 *
 * Prisma 7 stopped accepting `url` and `directUrl` inside `schema.prisma`.
 * The schema now describes the shape of the data and nothing about how to
 * reach it, which is the right split — a schema is checked into the
 * repository and a connection string is a per-install secret, and having them
 * in one file was always a small invitation to commit the second.
 *
 * `dotenv/config` at the top because the CLI no longer loads `.env` by
 * itself. Without it every migration command reports an empty URL, which
 * reads like a broken install rather than a missing import.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',

  migrations: {
    /*
     * Migrations run against `DIRECT_URL` where one is set.
     *
     * Supabase's pooled connection (pgbouncer, port 6543) cannot run DDL in
     * the transaction mode migrations need, so `DATABASE_URL` points at the
     * pooler for the application and `DIRECT_URL` at port 5432 for the CLI.
     * Falling back to `DATABASE_URL` keeps a plain single-endpoint Postgres —
     * a local one, or CI's container — working with no second variable.
     */
    seed: 'tsx prisma/seed.ts',
  },

  datasource: {
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || '',
  },
});

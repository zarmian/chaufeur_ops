# Deployment — Supabase and Vercel

One install per customer: separate Vercel project, separate Supabase project,
separate database. There is no tenant id anywhere in the schema, and adding
one later would be a rewrite — so never point two installs at one database.

Target: a new customer live in under an hour.

---

## 1. Supabase

1. Create a project. Choose the region closest to the operator — for a UK
   chauffeur company that is `eu-west-2` (London). Every job list query pays
   this latency.
2. Save the database password when it is shown. It is not recoverable.
3. **Project Settings → Database → Connection string** gives you two URLs.
   You need both, and they are not interchangeable:

   | Variable | Which string | Port | Why |
   |---|---|---|---|
   | `DATABASE_URL` | Transaction pooler | 6543 | What the app uses. Serverless functions open and drop connections constantly; without the pooler Postgres runs out of slots |
   | `DIRECT_URL` | Direct connection | 5432 | What migrations use. Prisma Migrate takes advisory locks and uses prepared statements, neither of which survive pgbouncer |

4. Append `?pgbouncer=true&connection_limit=1` to `DATABASE_URL`.

   Without `pgbouncer=true`, Prisma issues prepared statements the transaction
   pooler cannot hold, and you get `prepared statement "s0" already exists`
   errors — intermittently, under load, which is the worst way to find out.

```
DATABASE_URL="postgresql://postgres.abcdefgh:PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://postgres.abcdefgh:PASSWORD@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"
```

### What this project does not use Supabase for

Auth, storage and row-level security are all handled in the application:
Auth.js owns sessions, R2 owns files, and access control is the capability
model in `lib/permissions.ts`, enforced server-side. Supabase here is managed
Postgres and nothing more. Do not enable RLS on these tables — Prisma
connects as the owner and RLS would silently filter rows the application
expects to see.

---

## 2. First migration

From your own machine, with `.env` filled in:

```bash
npm ci
npm run db:deploy     # applies prisma/migrations — never `migrate dev` against production
npm run db:seed       # admin user, London zones, default rate card
npx tsx scripts/verify-install.ts
```

The seed prints the generated admin password once. Save it before closing the
terminal.

`verify-install` should end with `Ready.` It checks the pooler flags, that
migrations finished, and that an admin exists — the three things that
otherwise surface as a login failure at the worst moment.

### Alternative: the Supabase SQL editor

If you would rather not run Prisma locally, paste
`prisma/migrations/*/migration.sql` into the SQL editor and run it. Then
record it as applied so Prisma does not try again:

```sql
INSERT INTO _prisma_migrations
  (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES (gen_random_uuid(), '', '20260802000000_init', now(), now(), 1);
```

You still need `npm run db:seed` for the admin user.

---

## 3. Vercel

1. Import the repository. The framework is detected; leave the build command
   alone — `vercel.json` already sets it to
   `prisma generate && prisma migrate deploy && next build`, so every deploy
   applies pending migrations.
2. Environment variables, for Production and Preview:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | pooled string, with `pgbouncer=true` |
   | `DIRECT_URL` | direct string |
   | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `CRON_SECRET` | `openssl rand -hex 32` |
   | `SESSION_MAX_AGE_DAYS` | `30` (optional) |
   | `R2_*` | once document upload lands in Phase 1 |

   `AUTH_URL` is inferred on Vercel. Set it only for a custom domain that
   differs from the deployment URL.

3. Deploy.
4. Check `https://<deployment>/api/health` returns
   `{"status":"ok","database":"ok"}`. A 503 means the app is up but cannot
   reach Postgres — almost always a wrong or unpooled `DATABASE_URL`.
5. Sign in as the seeded admin.
6. Point uptime monitoring at `/api/health`.

### Cron

`vercel.json` registers the housekeeping job. Vercel sends
`Authorization: Bearer $CRON_SECRET`; the route rejects anything else with 401
before doing any work. Confirm the schedule appears under the project's Cron
Jobs tab after the first deploy — a cron declared in `vercel.json` but not
listed there means the deployment did not pick the file up.

### Preview deployments

Give previews their own database — a Supabase branch, or a second project.
Sharing production's would mean a preview build runs `migrate deploy` against
live data.

---

## 4. Per-customer checklist

For each new install:

- [ ] Supabase project in the customer's region; both connection strings saved
- [ ] Vercel project from the same repository
- [ ] `AUTH_SECRET` and `CRON_SECRET` generated fresh — never reused between
      customers, since one leaking would compromise the others
- [ ] `npm run db:deploy` and `npm run db:seed`
- [ ] `scripts/verify-install.ts` reports `Ready.`
- [ ] `/api/health` returns 200
- [ ] Admin password handed over and changed
- [ ] Branding, locale and reference prefixes configured (Phase 3)
- [ ] Real users created; the seeded admin retired or renamed
- [ ] Uptime monitoring and daily backups on

---

## Troubleshooting

**`prepared statement "s0" already exists`** — `pgbouncer=true` is missing
from `DATABASE_URL`.

**`Error: P1001: Can't reach database server`** — usually `DIRECT_URL`
pointing at port 6543 instead of 5432, or an unescaped character in the
password. Percent-encode it.

**Migrations hang** — Prisma Migrate is waiting on an advisory lock through
the pooler. `DIRECT_URL` must be the direct connection.

**Login always fails with correct credentials** — check `AUTH_SECRET` is set
and identical across deployments, and that the `Session` table exists. Sessions
live in Postgres, so a missing table fails the login rather than the request.

**Locked out by the rate limiter** — five failed attempts per IP per fifteen
minutes. Clear it with `DELETE FROM "LoginAttempt" WHERE ip = '…';` or wait.

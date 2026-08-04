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

Auth, storage and row-level security are all handled elsewhere: sessions live
in our own `Session` table, Vercel Blob owns files, and access control is the
capability model in `lib/permissions.ts`, enforced server-side. Supabase here
is managed Postgres and nothing more. Do not enable RLS on these tables — Prisma
connects as the owner and RLS would silently filter rows the application
expects to see.

---

## 2. Tables and the first administrator

**You do not need to run anything locally.** Vercel's build command is
`prisma generate && prisma migrate deploy && next build`, so deploying creates
the tables. What a fresh database still lacks is a user — without one there is
no way to sign in.

Two ways to create that first administrator. Pick one.

### Option A — the `/setup` page (no terminal)

After the first deploy, visit `https://<deployment>/setup`. It asks for:

- the **setup token** — your `SETUP_TOKEN`, or `CRON_SECRET` if you did not
  set one
- your name, email and a password of at least 12 characters

It creates the administrator, seeds the zones and default rate card, signs you
in, and then **permanently disables itself**. The page 404s from that moment
on, and a second submission is refused even if two people submit at the same
instant — the marker row's primary key is the mutex.

The page is public before it is used, which is unavoidable for a bootstrap.
That is why it needs the token, why failed token attempts count against the
same five-per-fifteen-minutes limit as failed logins, and why it is inert the
moment an administrator exists.

Once claimed it returns a plain 404 with no explanation. That is not
indistinguishable from any other unknown URL — an unknown path redirects an
anonymous visitor to `/login`, while `/setup` is public and 404s — so a
determined observer can tell the bootstrap has been used. What they cannot do
is use it. An *unclaimed* install, by contrast, advertises itself by showing
the form, which is the real reason to deploy and complete setup in the same
sitting rather than leaving a fresh deployment unattended.

### Option B — the seed script (terminal)

If you would rather not expose a bootstrap page at all:

```bash
npm ci
cp .env.example .env   # fill in the two connection strings
npm run db:deploy      # only if you have not deployed yet — Vercel does this
npm run db:seed        # admin user, zones, default rate card
npm run verify
```

The seed prints a generated password once. Save it before closing the
terminal. It also writes the same completion marker, so `/setup` is inert
before the deployment is ever reachable.

`npm run verify` should end with `Ready.` It checks the pooler flags, that
migrations finished rather than merely started, and that an admin exists.

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
   | `CRON_SECRET` | `openssl rand -hex 32` |
   | `SESSION_MAX_AGE_DAYS` | `30` (optional) |
   | `BLOB_READ_WRITE_TOKEN` | added automatically when you create a Blob store |

3. Deploy.
4. If you have not created an administrator yet, visit
   `https://<deployment>/setup` now and do it.
5. Check `https://<deployment>/api/health` returns
   `{"status":"ok","database":"ok"}`. A 503 means the app is up but cannot
   reach Postgres — almost always a wrong or unpooled `DATABASE_URL`.
6. Sign in.
7. Point uptime monitoring at `/api/health`.

### File storage

Documents — driver licences, PHV badges, MOT certificates — go to Vercel
Blob. In the Vercel dashboard: **Storage → Create → Blob**, connect it to the
project, and `BLOB_READ_WRITE_TOKEN` is added to the environment for you.
Redeploy afterwards so the running deployment picks it up.

Every object is written with `access: 'private'` and read through a signed URL
scoped to one pathname, one operation and fifteen minutes. There is no public
bucket to misconfigure, which matters because these are identity documents for
every driver on the fleet.

The app runs without a Blob store; only document upload is unavailable, and
the expiry dates that drive compliance live on the driver and vehicle records
regardless.

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
- [ ] `CRON_SECRET` generated fresh — never reused between customers, since
      one leaking would compromise the others
- [ ] First administrator created — via `/setup` or `npm run db:seed`
- [ ] `/setup` returns 404 afterwards
- [ ] `/api/health` returns 200
- [ ] Admin password recorded somewhere safe
- [ ] Branding, locale and reference prefixes configured (Phase 3)
- [ ] Real users created; the seeded admin retired or renamed
- [ ] Uptime monitoring and daily backups on

---

## Troubleshooting

**"The application could not start. Nothing has been changed."** — the
global boundary, meaning the failure was above every route-level one. Check
`/api/health` first: it distinguishes an unreachable database from a
reachable one with no tables, and prints the remedy for each. If `/api/health`
itself fails, the deployment is not booting — check the Vercel build and
function logs for the digest shown on the screen.

**`prepared statement "s0" already exists`** — `pgbouncer=true` is missing
from `DATABASE_URL`.

**`Error: P1001: Can't reach database server`** — usually `DIRECT_URL`
pointing at port 6543 instead of 5432, or an unescaped character in the
password. Percent-encode it.

**Migrations hang** — Prisma Migrate is waiting on an advisory lock through
the pooler. `DIRECT_URL` must be the direct connection.

**Login succeeds but every page bounces back to /login** — the cookie was
set but does not resolve to a `Session` row. Check the `Session` table exists
and that the app and migrations point at the same database. There is no
signing secret to get wrong: the cookie holds a random token and the table
stores its SHA-256 hash.

**Locked out by the rate limiter** — five failed attempts per IP per fifteen
minutes, counting failed setup-token attempts too. Clear it with
`DELETE FROM "LoginAttempt" WHERE ip = '…';` or wait.

**`/setup` returns 404 on a brand new install** — something already created a
user, or the completion marker is present. Check with
`SELECT * FROM "Setting" WHERE key = 'install.completed';` and
`SELECT count(*) FROM "User";`. If you genuinely need to redo it, delete both.

**`/setup` says the token is not correct** — neither `SETUP_TOKEN` nor
`CRON_SECRET` is set in the deployment, or you are comparing against a
different environment's value. A missing token fails closed by design.

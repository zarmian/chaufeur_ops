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

### Option B — the setup wizard (terminal, recommended)

`npm run setup` asks for the company details, the locale and the first
administrator, then seeds the zones and the default rate card. It is the same
work `/setup` does from a browser — both call `completeInstall`, so the two
cannot drift into seeding different things — but it also captures the
branding and locale, which the browser page does not.

```bash
npm ci
cp .env.example .env   # fill in the two connection strings
npm run db:deploy      # only if you have not deployed yet — Vercel does this
npm run setup
npm run verify
```

It refuses to run twice. On an install that already has an administrator it
prints "already set up" and changes nothing, so it is safe to leave in a
deployment script.

For an unattended install, pipe the answers in the order the questions are
asked. Blank lines take the default shown in brackets:

```bash
printf '%s\n' \
  'Northwind Chauffeurs' \
  ''                      `# legal name — defaults to the trading name` \
  'support@example.com' \
  '020 7946 0000' \
  'NWC'                   `# job reference prefix` \
  ''                      `# invoice prefix — defaults to INV` \
  '' '' '' '' '' ''       `# six locale answers — all UK defaults` \
  'Ada Lovelace' \
  'ada@example.com' \
  "$ADMIN_PASSWORD" \
  "$ADMIN_PASSWORD" \
  | npm run setup
```

The password is echoed as asterisks, so it does not land in a deployment log
— but it is still on the command line, so prefer an environment variable to a
literal.

### Option C — the seed script (terminal, unattended)

If you would rather not expose a bootstrap page at all:

```bash
npm ci
cp .env.example .env   # fill in the two connection strings
npm run db:deploy      # only if you have not deployed yet — Vercel does this
npm run db:seed        # admin user, zones, airport terminals, default rate card
npm run verify
```

The seed prints a generated password once. Save it before closing the
terminal. For a scripted install, set `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` first and it uses those instead of generating one. It also writes the same completion marker, so `/setup` is inert
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

### Backups and restore

Supabase takes a daily logical backup on every paid plan; on the free plan it
does not, which is the single most important thing to know before putting a
customer on one. **Storage → Backups** in the Supabase dashboard shows the
retention window.

A backup nobody has restored is a hope, not a backup. Test it once when the
install is stood up, and again whenever Postgres is upgraded:

1. Create a scratch Supabase project — not the customer's.
2. Download the most recent backup and restore it into the scratch project:

   ```
   pg_restore --no-owner --no-privileges \
     --dbname "$SCRATCH_DIRECT_URL" backup.dump
   ```

3. Point a local checkout at it and check the data is actually there:

   ```
   DATABASE_URL="$SCRATCH_DIRECT_URL" DIRECT_URL="$SCRATCH_DIRECT_URL" \
     npm run verify
   ```

4. Sign in against it and open one invoice. `verify` proves the schema; only
   a screen proves the rows.
5. Delete the scratch project.

Record the date of the last successful restore test somewhere the customer
can see it. Six months is long enough for a backup job to have been silently
failing.

Two things worth knowing about what a restore does and does not bring back.
Documents live in Vercel Blob, not Postgres, so a database restore returns
every driver's expiry dates and every document's metadata but not the files
themselves — Blob has its own retention, and losing both at once means
re-collecting licences from 200 drivers. And restoring over a live database
invalidates every session row, so everyone is signed out; that is correct
behaviour, not a fault.

### Uptime monitoring

Point a monitor at `/api/health` on a one-minute interval and alert on two
consecutive failures. The route checks Postgres rather than just returning
200, so it distinguishes three states that need different responses:

| Response | Means | Do |
|---|---|---|
| `200 {"status":"ok"}` | app and database both up | nothing |
| `503 {"database":"unreachable"}` | app up, Postgres not | check Supabase status and the connection string |
| `503 {"schema":"missing"}` | database reachable, no tables | migrations have not run — redeploy |

It says nothing about credentials, hosts or install state, so it is safe to
leave unauthenticated and to give to a third-party monitor.

Unhandled route errors are logged as structured JSON regardless of
configuration, so a Vercel log drain searching for `"level":"error"` finds
them. Setting `SENTRY_DSN` additionally posts them to Sentry with the acting
user's id and role attached — see `.env.example`.

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
- [ ] `APP_URL` set to this install's own address, no trailing slash. Only
      messages the system *pushes* need it — a driver's Telegram job card
      carries a link to the passenger's name board, and there is no incoming
      request to resolve that against — but without it the link is silently
      omitted, and the webhook check below has nothing to compare against
- [ ] `BLOB_READ_WRITE_TOKEN` set from **a Blob store of this install's own**,
      or accept that documents and logos cannot be uploaded — everything else
      works without it. Two installs sharing a store never collide, because
      object keys carry a UUID, which is exactly why it would never announce
      itself: one customer's driver licences and insurance certificates simply
      accumulate in another customer's bucket
- [ ] A Telegram bot of this install's own — see below. Never the same bot as
      another install
- [ ] First administrator created — `npm run setup`, `/setup` or
      `npm run db:seed`
- [ ] `/setup` returns 404 afterwards
- [ ] `/api/health` returns 200
- [ ] Admin password recorded somewhere safe
- [ ] Branding configured: trading name, logos, colours, reference prefixes
- [ ] Locale checked — currency, timezone, tax name and rate
- [ ] Vehicles imported, then drivers, then clients
- [ ] Compliance screen reviewed: every import lands its undated documents
      there, and that backlog is the first real job
- [ ] Real users created; the seeded admin retired or renamed
- [ ] Uptime monitoring on `/api/health`, alerting on two consecutive fails
- [ ] Daily backups on — free-plan Supabase projects have none
- [ ] Restore tested once into a scratch project, and the date recorded
- [ ] `SENTRY_DSN` set, or accept log-only error capture

### Telegram

Each install needs **its own bot**, and this is the one mistake on the whole
page that does real damage.

A bot has exactly one webhook URL. Point two installs at the same bot and the
second one to register wins: from that moment the first company's drivers are
accepting jobs, tapping arrival and filing expenses into the second company's
database. Every screen still works. Nothing logs an error. It surfaces weeks
later as a driver swearing blind they completed a job the office has no record
of.

For each install:

- [ ] A new bot from @BotFather, named for that customer
- [ ] Its token in Settings → Telegram (stored encrypted), or
      `TELEGRAM_BOT_TOKEN` in the deployment
- [ ] `SETTINGS_ENCRYPTION_KEY` set **before** any token is saved —
      `openssl rand -hex 32`, fresh per install. Without it, saving a
      credential is refused rather than falling back to plaintext, and the
      first anyone learns of it is a red banner mid-setup. Changing it later
      makes every stored credential unreadable, so set it once and keep it
- [ ] The ops and admin bot **usernames** in Settings → Telegram. They are
      what the driver and staff links are built from; without them the
      buttons that issue those links are disabled
- [ ] `TELEGRAM_WEBHOOK_SECRET` generated fresh, per install
- [ ] The webhook registered against **this install's** address — either
      **Settings → Telegram → Register webhooks**, or:

      npx tsx scripts/register-webhook.ts

      Both read `APP_URL`, the stored bot tokens and the webhook secret, so
      there is no address to paste and none to mistype. They also read the
      registration back afterwards and say whose install each bot is pointed
      at, because Telegram answering "ok" only means it accepted the call.

- [ ] `npx tsx scripts/verify-install.ts` reports *"webhook points at this
      install"* for every configured bot. It asks Telegram directly and fails
      if the answer is anywhere else, which is the only automated protection
      against the mix-up above

An admin bot, if used, is a second bot and gets the same treatment.

### Two installs, one repository

Both Vercel projects deploy from this repository. That is the point — one
codebase, and the only difference between customers is configuration — but it
puts two things on whoever releases.

**Migrations run per database.** A deploy applies migrations to the database
that deployment points at, and to no other. An install that has not been
deployed since a schema change is running old tables against new code. Deploy
both, and check `verify-install` on each afterwards — it reports how many
migrations are applied.

**A release reaches whichever install you deploy.** Vercel will build both
automatically from the same branch if both projects are wired to it, which is
usually what you want. If one is pinned to a different branch or paused,
write it down somewhere the next person will look, because a customer running
a fortnight behind is not visible from inside the application.

**Nothing is shared but the code.** Separate databases, separate Blob stores,
separate bots, separate secrets. If a change ever appears to need one install
to read another's data, that is a product decision and not a deployment
detail — see the note in `CLAUDE.md`.

### Standing one up end to end

Roughly an hour, most of it waiting for Vercel.

| Step | Where | Time |
|---|---|---|
| Supabase project, connection strings | Supabase | 5 min |
| Blob store for this install | Vercel | 2 min |
| Vercel project, environment variables | Vercel | 10 min |
| First deploy (runs migrations) | Vercel | 5 min |
| `npm run setup` — company, locale, admin | Terminal | 5 min |
| Bot, webhook, secret | @BotFather, then Settings → Telegram | 5 min |
| `npx tsx scripts/verify-install.ts` — all green | Terminal | 2 min |
| Branding — logos and colours | Settings → Branding | 5 min |
| Import vehicles, drivers, clients | Settings → Import | 10 min |

Run `verify-install` before anyone logs in and again after the bot is wired
up. It is the only thing that will tell you the webhook is pointed at this
install rather than at somebody else's.

Import the vehicles first. The driver file can name a car by registration,
which links the two in one pass — but only for vehicles already loaded.
Drivers first still works; their registrations come back as unmatched, and
re-running the same driver file afterwards picks them up, because an import
matches on the natural key and updates rather than duplicating.

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

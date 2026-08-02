# Phase 0 — Foundation

**Goal:** a deployed, authenticated shell with the database schema in place and the audit log working. No business features yet.

**Depends on:** nothing.

---

## 0.1 Project setup

Next.js 15 App Router, TypeScript strict, Tailwind, shadcn/ui, Prisma, Vitest, Playwright, ESLint + Prettier.

**Acceptance criteria**
1. `npm run dev` starts cleanly with no type errors
2. `npm run typecheck`, `npm run lint` and `npm run test` all pass on an empty suite
3. `.env.example` lists every variable the app reads, with comments
4. README documents local setup in under ten steps

## 0.2 Database and schema

Implement `docs/data-model.md` in full — every model, enum, index and relation.

**Acceptance criteria**
1. `npx prisma migrate dev` applies cleanly to an empty database
2. Every enum, model, relation and index from the data model exists
3. `lib/money.ts` exports `formatGBP(pence)`, `parseGBP(string)` and `roundPence(number)`, all unit-tested including negatives and half-penny rounding
4. `lib/dates.ts` exports `toUTC(localDateTime)` and `toLondon(utcDate)`, unit-tested across both 2026 BST transitions
5. A seed script creates one `ADMIN` user, a default rate card and the standard London zones

## 0.3 Soft delete and audit middleware

**Acceptance criteria**
1. Prisma middleware excludes rows with `deletedAt != null` from all finds unless `includeDeleted` is explicitly passed
2. `delete` calls on primary entities are rewritten to set `deletedAt`
3. `lib/audit.ts` exposes `withAudit(entity, action, fn)` capturing before and after snapshots
4. Creating, updating and deleting any of Job, JobFinance, Invoice, Driver, Vehicle or Client writes an `AuditLog` row with the acting user
5. Audit writes happen in the same transaction as the change — a failed mutation leaves no audit entry
6. Test proves a soft-deleted job is absent from list queries and present with `includeDeleted`

## 0.4 Authentication and roles

Auth.js v5, credentials provider, database sessions.

**Acceptance criteria**
1. Login page with email and password; failures give a generic message that does not reveal whether the email exists
2. Passwords hashed with argon2id (or bcrypt cost ≥ 12)
3. Session carries `userId` and `role`
4. `requireRole(...roles)` helper guards Server Actions and route handlers, returning `403 FORBIDDEN`
5. Middleware redirects unauthenticated users to `/login` for every `(dashboard)` route
6. Rate limit: 5 failed attempts per 15 minutes per IP, then a lockout message
7. `lastLoginAt` updates on success
8. E2E test: `VIEWER` receives 403 attempting a job mutation

## 0.5 Application shell

**Acceptance criteria**
1. Sidebar navigation: Dashboard, Jobs, Dispatch, Drivers, Vehicles, Clients, Accounts, Invoices, Payouts, Reports, Settings
2. Navigation items hide when the current role cannot access them — with the server-side guard still enforced regardless
3. Header shows the user's name, role and a sign-out control
4. Responsive down to tablet width; the ops team works on laptops, not phones
5. Loading and error boundaries on every route segment
6. A dashboard placeholder page

## 0.6 File storage

**Acceptance criteria**
1. Cloudflare R2 configured; credentials from env
2. `lib/storage.ts` exposes `upload(buffer, key, mimeType)`, `getSignedUrl(key, ttlSeconds)` and `delete(key)`
3. Signed URLs default to 15 minutes
4. Upload rejects anything outside jpeg, png, webp, pdf, and anything over 10 MB
5. Keys are namespaced: `documents/{entityType}/{entityId}/{uuid}-{filename}`

## 0.7 Deployment

**Acceptance criteria**
1. Deploys to Vercel from the main branch
2. Managed Postgres provisioned (Neon or Supabase); connection pooling configured for serverless
3. Migrations run automatically on deploy
4. Preview deployments get their own branch database
5. `/api/health` returns 200 with a database connectivity check
6. `CRON_SECRET` set; a stub cron route returns 401 without the correct bearer token

---

## Definition of done

- All acceptance criteria pass
- `npm run typecheck && npm run lint && npm run test` clean
- Deployed, reachable, admin can log in
- Zero business logic — resist adding "just the job list while I'm here"

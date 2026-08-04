/**
 * Option lists for the enum-backed select fields.
 *
 * These live apart from `lib/drivers.ts`, `lib/vehicles.ts` and
 * `lib/accounts.ts` for one reason: those modules reach Postgres, and a
 * Client Component that imports one drags `PrismaClient` into the browser
 * bundle. Prisma's browser build throws the moment a property is read, which
 * happens during hydration — so the form renders from the server, then blows
 * up and is replaced by the error boundary. It looks like "creating a record
 * is broken" and it is very hard to read backwards from the symptom.
 *
 * This module imports nothing. Keep it that way, and import the option lists
 * from here in anything marked `'use client'`.
 *
 * `value` must match the Prisma enum member exactly — it is what the form
 * posts and what Zod validates.
 */

export const DRIVER_STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'SUSPENDED', label: 'Suspended' },
] as const;

export const VEHICLE_CLASSES = [
  { value: 'SALOON', label: 'Saloon' },
  { value: 'EXECUTIVE', label: 'Executive' },
  { value: 'LUXURY', label: 'Luxury' },
  { value: 'MPV', label: 'MPV' },
  { value: 'SUV', label: 'SUV' },
  { value: 'ELECTRIC_EXECUTIVE', label: 'Electric executive' },
] as const;

export const VEHICLE_STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'OFF_ROAD', label: 'Off road' },
  { value: 'RETIRED', label: 'Retired' },
] as const;

export const ACCOUNT_KINDS = [
  { value: 'INTERNAL', label: 'Internal' },
  { value: 'AGENCY', label: 'Agency' },
  { value: 'CORPORATE', label: 'Corporate' },
  { value: 'INDIVIDUAL', label: 'Individual' },
] as const;

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

/**
 * How a vehicle is held. `DRIVER_OWNED` is first because it is the default
 * and the common case — most of the fleet belongs to its driver.
 */
export const VEHICLE_OWNERSHIPS = [
  { value: 'DRIVER_OWNED', label: "Driver's own car" },
  { value: 'OWNED', label: 'Company owned' },
  { value: 'FINANCED', label: 'Company, on finance' },
  { value: 'LEASED', label: 'Company, leased' },
] as const;

export const ACCOUNT_KINDS = [
  { value: 'INTERNAL', label: 'Internal' },
  { value: 'AGENCY', label: 'Agency' },
  { value: 'CORPORATE', label: 'Corporate' },
  { value: 'INDIVIDUAL', label: 'Individual' },
] as const;

export const JOB_TYPES = [
  { value: 'TRANSFER', label: 'Transfer' },
  { value: 'AIRPORT_TRANSFER', label: 'Airport transfer' },
  { value: 'AS_DIRECTED', label: 'As directed (hourly)' },
  { value: 'CONTRACT', label: 'Contract (per day)' },
] as const;

export const JOB_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'NO_SHOW', label: 'No show' },
] as const;

export const PAY_STATUSES = [
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'PARTIALLY_PAID', label: 'Partially paid' },
  { value: 'FULLY_PAID', label: 'Fully paid' },
] as const;

export const PAY_METHODS = [
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'INVOICE', label: 'Invoice' },
] as const;

/**
 * The staff roles, and what each is for in the words the screen shows.
 *
 * Here rather than in `lib/users.ts` because the role picker is a Client
 * Component, and `lib/users.ts` reaches Prisma, argon2 and the session store.
 * Importing it from the browser would pull all three into the bundle.
 */
export const ROLES = ['ADMIN', 'OPS', 'ACCOUNTS', 'VIEWER'] as const;

export const ROLE_DESCRIPTIONS: Record<(typeof ROLES)[number], string> = {
  ADMIN: 'Everything, including users, settings and deleting records',
  OPS: 'Jobs, drivers, vehicles, dispatch and documents. Cannot see or change money',
  ACCOUNTS: 'Prices, invoices, payouts and reports. Cannot change operational job details',
  VIEWER: 'Read-only throughout',
};

/**
 * How far back a contract's rate change reaches — see `repriceContractJobs`.
 *
 * Here rather than in `lib/contracts.ts` because the contract form is a Client
 * Component and that module reaches Postgres. `lib/client-bundle.test.ts`
 * caught it importing this list directly.
 */
export type RepriceScope = 'none' | 'upcoming' | 'all';

export const REPRICE_SCOPES = [
  {
    value: 'none',
    label: 'Only days created from now on',
    description: 'Days already booked keep the price they were given.',
  },
  {
    value: 'upcoming',
    label: 'Also days not yet started',
    description:
      'Everything still to happen is repriced. Days already worked keep what they were billed at.',
  },
  {
    value: 'all',
    label: 'Also days already worked',
    description:
      'Every day this contract has made, back to the beginning. For a rate agreed after the fact.',
  },
] as const;

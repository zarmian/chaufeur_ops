import type { UserRole } from '@prisma/client';

/**
 * Who may do what — as data, with no dependency on how a session is
 * resolved. `lib/authz.ts` binds these to the signed-in user.
 *
 * Kept separate so the rules are testable on their own and so importing a
 * permission check does not pull Auth.js into, say, a route-handler helper.
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
}

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly status = 401 as const;
  constructor() {
    super('No valid session');
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;
  readonly status = 403 as const;
  constructor(message = 'Your role does not permit this') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Named capabilities rather than role checks scattered through the codebase,
 * so "who may edit a price" has one answer and that answer is testable.
 *
 * The shape of it follows the role table in CLAUDE.md: OPS runs the
 * operation and does not touch money; ACCOUNTS touches money and does not
 * touch operational job fields; deletes and settings are ADMIN alone.
 */
export const CAPABILITIES = {
  manageUsers: ['ADMIN'],
  manageSettings: ['ADMIN'],
  deleteRecords: ['ADMIN'],
  viewAuditLog: ['ADMIN'],

  editJobs: ['ADMIN', 'OPS'],
  editDrivers: ['ADMIN', 'OPS'],
  editVehicles: ['ADMIN', 'OPS'],
  editDocuments: ['ADMIN', 'OPS'],
  dispatch: ['ADMIN', 'OPS'],

  editClients: ['ADMIN', 'OPS'],
  editClientBilling: ['ADMIN', 'OPS', 'ACCOUNTS'],

  editJobFinances: ['ADMIN', 'ACCOUNTS'],
  editInvoices: ['ADMIN', 'ACCOUNTS'],
  editPayouts: ['ADMIN', 'ACCOUNTS'],
  viewReports: ['ADMIN', 'ACCOUNTS', 'OPS'],
  viewRevenue: ['ADMIN', 'ACCOUNTS'],

  viewJobs: ['ADMIN', 'OPS', 'ACCOUNTS', 'VIEWER'],
  viewInvoices: ['ADMIN', 'OPS', 'ACCOUNTS', 'VIEWER'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(
  user: Pick<SessionUser, 'role'> | null | undefined,
  capability: Capability,
): boolean {
  if (!user) return false;
  return (CAPABILITIES[capability] as readonly UserRole[]).includes(user.role);
}

export function hasRole(
  user: Pick<SessionUser, 'role'> | null | undefined,
  ...roles: UserRole[]
): boolean {
  return user ? roles.includes(user.role) : false;
}

/** `editJobFinances` -> `edit job finances`, for a readable refusal. */
export function describeCapability(capability: Capability): string {
  return capability
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
}

import type { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, can, hasRole, type Capability } from './permissions';

const user = (role: UserRole) => ({ role });

describe('role capabilities', () => {
  it('gives ADMIN everything', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      expect(can(user('ADMIN'), capability)).toBe(true);
    }
  });

  it('keeps OPS out of money', () => {
    // OPS runs the operation. Prices, invoices and payouts are not theirs.
    expect(can(user('OPS'), 'editJobs')).toBe(true);
    expect(can(user('OPS'), 'editDrivers')).toBe(true);
    expect(can(user('OPS'), 'dispatch')).toBe(true);

    expect(can(user('OPS'), 'editJobFinances')).toBe(false);
    expect(can(user('OPS'), 'editInvoices')).toBe(false);
    expect(can(user('OPS'), 'editPayouts')).toBe(false);
    expect(can(user('OPS'), 'viewRevenue')).toBe(false);
  });

  it('keeps ACCOUNTS out of operational job fields', () => {
    expect(can(user('ACCOUNTS'), 'editJobFinances')).toBe(true);
    expect(can(user('ACCOUNTS'), 'editInvoices')).toBe(true);
    expect(can(user('ACCOUNTS'), 'editClientBilling')).toBe(true);

    expect(can(user('ACCOUNTS'), 'editJobs')).toBe(false);
    expect(can(user('ACCOUNTS'), 'editDrivers')).toBe(false);
    expect(can(user('ACCOUNTS'), 'dispatch')).toBe(false);
  });

  it('lets VIEWER read and nothing else', () => {
    expect(can(user('VIEWER'), 'viewJobs')).toBe(true);
    expect(can(user('VIEWER'), 'viewInvoices')).toBe(true);

    const writes: Capability[] = [
      'editJobs',
      'editJobFinances',
      'editInvoices',
      'editDrivers',
      'editVehicles',
      'editClients',
      'editDocuments',
      'editPayouts',
      'manageUsers',
      'manageSettings',
      'deleteRecords',
    ];
    for (const capability of writes) {
      expect(can(user('VIEWER'), capability)).toBe(false);
    }
  });

  it('reserves deletes, users, settings and the audit log for ADMIN', () => {
    for (const role of ['OPS', 'ACCOUNTS', 'VIEWER'] as UserRole[]) {
      expect(can(user(role), 'deleteRecords')).toBe(false);
      expect(can(user(role), 'manageUsers')).toBe(false);
      expect(can(user(role), 'manageSettings')).toBe(false);
      expect(can(user(role), 'viewAuditLog')).toBe(false);
    }
  });

  it('refuses everything to an anonymous caller', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      expect(can(null, capability)).toBe(false);
      expect(can(undefined, capability)).toBe(false);
    }
  });
});

describe('hasRole', () => {
  it('matches any of the listed roles', () => {
    expect(hasRole(user('OPS'), 'ADMIN', 'OPS')).toBe(true);
    expect(hasRole(user('VIEWER'), 'ADMIN', 'OPS')).toBe(false);
    expect(hasRole(null, 'ADMIN')).toBe(false);
  });
});

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { diffSnapshots, toJsonSnapshot } from './audit';

describe('toJsonSnapshot', () => {
  it('converts a Date to an ISO string', () => {
    expect(toJsonSnapshot({ scheduledAt: new Date('2026-08-02T13:30:00Z') })).toEqual(
      { scheduledAt: '2026-08-02T13:30:00.000Z' },
    );
  });

  it('converts a BigInt rather than throwing', () => {
    // Telegram chat ids are BigInt. JSON.stringify throws on them, which
    // would turn an audit write into a failed mutation.
    expect(toJsonSnapshot({ telegramChatId: 123456789012345n })).toEqual({
      telegramChatId: '123456789012345',
    });
  });

  it('converts a Decimal to a string, preserving trailing precision', () => {
    expect(
      toJsonSnapshot({ commissionPct: new Prisma.Decimal('12.50') }),
    ).toEqual({ commissionPct: '12.5' });
  });

  it('keeps money as the integer it is', () => {
    expect(toJsonSnapshot({ clientPricePence: 12550 })).toEqual({
      clientPricePence: 12550,
    });
  });

  it('redacts secrets so the audit log is not a credential store', () => {
    expect(
      toJsonSnapshot({
        email: 'someone@example.com',
        passwordHash: '$argon2id$v=19$...',
        sessionToken: 'abc',
        token: 'drv_xyz',
      }),
    ).toEqual({
      email: 'someone@example.com',
      passwordHash: '[redacted]',
      sessionToken: '[redacted]',
      token: '[redacted]',
    });
  });

  it('walks nested objects and arrays', () => {
    expect(
      toJsonSnapshot({
        lines: [
          { amountPence: 100, createdAt: new Date('2026-01-01T00:00:00Z') },
        ],
        nested: { deep: { password: 'hunter2' } },
      }),
    ).toEqual({
      lines: [{ amountPence: 100, createdAt: '2026-01-01T00:00:00.000Z' }],
      nested: { deep: { password: '[redacted]' } },
    });
  });

  it('normalises null and undefined', () => {
    expect(toJsonSnapshot({ notes: null, viaText: undefined })).toEqual({
      notes: null,
      viaText: null,
    });
  });

  it('summarises binary instead of embedding it', () => {
    expect(toJsonSnapshot({ blob: new Uint8Array(12) })).toEqual({
      blob: '[binary 12 bytes]',
    });
  });

  it('survives a round trip through JSON.stringify', () => {
    const snapshot = toJsonSnapshot({
      id: 'clx1',
      telegramChatId: 99n,
      scheduledAt: new Date('2026-08-02T13:30:00Z'),
      commissionPct: new Prisma.Decimal('7.25'),
    });
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
});

describe('diffSnapshots', () => {
  it('reports only what changed', () => {
    const before = { clientPricePence: 12500, status: 'PENDING', notes: 'x' };
    const after = { clientPricePence: 13500, status: 'PENDING', notes: 'x' };

    expect(diffSnapshots(before, after)).toEqual({
      clientPricePence: { from: 12500, to: 13500 },
    });
  });

  it('reports a field appearing or disappearing', () => {
    expect(diffSnapshots({ a: 1 }, { a: 1, b: 2 })).toEqual({
      b: { from: undefined, to: 2 },
    });
  });

  it('is empty when nothing changed', () => {
    expect(diffSnapshots({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('returns nothing useful for non-objects rather than throwing', () => {
    expect(diffSnapshots(null, { a: 1 })).toEqual({});
    expect(diffSnapshots('a', 'b')).toEqual({});
  });
});

import type { JobStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  canTransition,
  eventTypeForStatus,
  hasPriceOrReason,
  isTerminal,
  isUnpriced,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  type TransitionContext,
} from './job-status';

/**
 * The transition rules decide whether a job can be completed without a price.
 * That single question is the reason this system is being built, so the
 * guards get exhaustive coverage rather than a happy-path test.
 */

const ALL_STATUSES: JobStatus[] = [
  'DRAFT',
  'PENDING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

/** A job that would pass every guard, so each test can break exactly one. */
function job(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    status: 'PENDING',
    driverId: 'drv_1',
    vehicleId: 'veh_1',
    clientPricePence: 12550,
    zeroValueReason: null,
    lockedByInvoice: null,
    compliance: { compliant: true, reasons: [] },
    ...overrides,
  };
}

describe('the transition graph', () => {
  it('matches the diagram in data-model.md', () => {
    expect(allowedTransitions('DRAFT')).toEqual(['PENDING', 'CANCELLED']);
    expect(allowedTransitions('PENDING')).toEqual(['ASSIGNED', 'CANCELLED']);
    expect(allowedTransitions('IN_PROGRESS')).toEqual([
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
  });

  it('lets a job walk the whole happy path', () => {
    const path: JobStatus[] = [
      'PENDING',
      'ASSIGNED',
      'ACCEPTED',
      'IN_PROGRESS',
      'COMPLETED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransition(job({ status: from }), to), `${from} -> ${to}`).toEqual({
        ok: true,
      });
    }
  });

  it('counts the three finished statuses as terminal', () => {
    // Terminal means the work has finished, which is what the lists and the
    // counts ask. It is not the same question as "can this still change" —
    // a completed job can still be cancelled.
    expect([...TERMINAL_STATUSES]).toEqual(['COMPLETED', 'CANCELLED', 'NO_SHOW']);
    for (const status of ALL_STATUSES) {
      expect(isTerminal(status), status).toBe(TERMINAL_STATUSES.includes(status));
    }
  });

  it('never lets a cancelled or no-show job change again', () => {
    for (const status of ['CANCELLED', 'NO_SHOW'] as const) {
      expect(isTerminal(status)).toBe(true);
      for (const next of ALL_STATUSES) {
        const result = canTransition(job({ status }), next);
        expect(result.ok, `${status} -> ${next}`).toBe(false);
      }
    }
  });

  it('lets a completed job be cancelled, and nothing else', () => {
    // The one thing a completed job may still do. Marking the wrong job off
    // the board should not leave work on the books that never happened.
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(allowedTransitions('COMPLETED')).toEqual(['CANCELLED']);
    expect(canTransition(job({ status: 'COMPLETED' }), 'CANCELLED')).toEqual({
      ok: true,
    });

    for (const next of ALL_STATUSES.filter((s) => s !== 'CANCELLED')) {
      const result = canTransition(job({ status: 'COMPLETED' }), next);
      expect(result.ok, `COMPLETED -> ${next}`).toBe(false);
    }
  });

  it('does not tell a completed job it cannot change status', () => {
    // It can — it can be cancelled. Saying otherwise sends somebody looking
    // for a workaround for a thing the button on the page already does.
    const sealed = canTransition(job({ status: 'CANCELLED' }), 'PENDING');
    if (!sealed.ok) expect(sealed.message).toContain('cannot change status');

    const completed = canTransition(job({ status: 'COMPLETED' }), 'IN_PROGRESS');
    if (!completed.ok) {
      expect(completed.message).not.toContain('cannot change status');
      expect(completed.message).toContain('in progress');
    }
  });

  it('refuses to move a job backwards', () => {
    const result = canTransition(job({ status: 'IN_PROGRESS' }), 'ASSIGNED');
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('refuses to skip assignment', () => {
    // A job cannot be in progress before anyone has been given it.
    expect(canTransition(job({ status: 'PENDING' }), 'IN_PROGRESS')).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
    });
  });

  it('treats a no-op transition as invalid rather than silently succeeding', () => {
    const result = canTransition(job({ status: 'ASSIGNED' }), 'ASSIGNED');
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    if (!result.ok) expect(result.message).toContain('already');
  });

  it('allows cancelling from every live status', () => {
    for (const status of ['DRAFT', 'PENDING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] as const) {
      expect(canTransition(job({ status }), 'CANCELLED'), status).toEqual({ ok: true });
    }
  });

  it('allows NO_SHOW only once someone has been assigned', () => {
    // Nobody can fail to show up for a job that was never given to them.
    expect(canTransition(job({ status: 'PENDING' }), 'NO_SHOW').ok).toBe(false);
    expect(canTransition(job({ status: 'ASSIGNED' }), 'NO_SHOW')).toEqual({ ok: true });
    expect(canTransition(job({ status: 'IN_PROGRESS' }), 'NO_SHOW')).toEqual({ ok: true });
  });
});

describe('assignment guards', () => {
  it('needs a driver and a vehicle, and says which is missing', () => {
    const noDriver = canTransition(job({ driverId: null }), 'ASSIGNED');
    expect(noDriver).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    if (!noDriver.ok) expect(noDriver.message).toContain('a driver');

    const neither = canTransition(
      job({ driverId: null, vehicleId: null }),
      'ASSIGNED',
    );
    if (!neither.ok) {
      expect(neither.message).toContain('a driver');
      expect(neither.message).toContain('a vehicle');
    }
  });

  it('blocks assignment on lapsed documents and passes the reasons through', () => {
    // The operator has to be told *which* document, or they cannot fix it.
    const result = canTransition(
      job({
        compliance: {
          compliant: false,
          reasons: ['PHV badge expired 10 days ago', 'MOT expires in 2 days'],
        },
      }),
      'ASSIGNED',
    );
    expect(result).toMatchObject({ ok: false, code: 'DOCUMENT_EXPIRED' });
    if (!result.ok) {
      expect(result.reasons).toEqual([
        'PHV badge expired 10 days ago',
        'MOT expires in 2 days',
      ]);
    }
  });

  it('reports a missing driver before a compliance failure', () => {
    // "Pick a driver" is actionable; "that driver is non-compliant" when there
    // is no driver is nonsense.
    const result = canTransition(
      job({ driverId: null, compliance: { compliant: false, reasons: ['x'] } }),
      'ASSIGNED',
    );
    expect(result).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('does not apply compliance rules to other transitions', () => {
    // A badge lapsing must not strand a job that is already under way.
    const result = canTransition(
      job({
        status: 'IN_PROGRESS',
        compliance: { compliant: false, reasons: ['PHV badge expired'] },
      }),
      'COMPLETED',
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('the price guard on COMPLETED', () => {
  it('refuses a completion with no price and no reason', () => {
    const result = canTransition(
      job({ status: 'IN_PROGRESS', clientPricePence: null }),
      'COMPLETED',
    );
    expect(result).toMatchObject({ ok: false, code: 'PRICE_REQUIRED' });
  });

  it('refuses a zero price the same way', () => {
    // Zero is what the legacy system stored 140 times out of 141. It is a
    // missing answer, not a free job.
    expect(
      canTransition(job({ status: 'IN_PROGRESS', clientPricePence: 0 }), 'COMPLETED'),
    ).toMatchObject({ code: 'PRICE_REQUIRED' });
  });

  it('refuses a whitespace-only zero-value reason', () => {
    expect(
      canTransition(
        job({ status: 'IN_PROGRESS', clientPricePence: 0, zeroValueReason: '   ' }),
        'COMPLETED',
      ),
    ).toMatchObject({ code: 'PRICE_REQUIRED' });
  });

  it('accepts an unpriced job once a reason is recorded', () => {
    expect(
      canTransition(
        job({
          status: 'IN_PROGRESS',
          clientPricePence: 0,
          zeroValueReason: 'Goodwill',
        }),
        'COMPLETED',
      ),
    ).toEqual({ ok: true });
  });

  it('does not block cancelling an unpriced job', () => {
    // The price only matters for work that was actually delivered.
    expect(
      canTransition(
        job({ status: 'IN_PROGRESS', clientPricePence: null }),
        'CANCELLED',
      ),
    ).toEqual({ ok: true });
  });
});

describe('the invoice lock', () => {
  it('refuses to cancel a job on a sent invoice and names it', () => {
    const result = canTransition(
      job({
        status: 'IN_PROGRESS',
        lockedByInvoice: { reference: 'INV-0042', status: 'SENT', issued: true },
      }),
      'CANCELLED',
    );
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_LOCKED' });
    if (!result.ok) {
      expect(result.message).toContain('INV-0042');
      expect(result.message).toContain('credit note');
    }
  });

  it('does not block completion of an invoiced job', () => {
    // Only cancellation is destructive to a sent invoice.
    expect(
      canTransition(
        job({
          status: 'IN_PROGRESS',
          lockedByInvoice: { reference: 'INV-0042', status: 'PAID', issued: true },
        }),
        'COMPLETED',
      ),
    ).toEqual({ ok: true });
  });

  it('keeps a completed job cancellable until it is invoiced', () => {
    expect(canTransition(job({ status: 'COMPLETED' }), 'CANCELLED')).toEqual({
      ok: true,
    });

    const result = canTransition(
      job({
        status: 'COMPLETED',
        lockedByInvoice: { reference: 'INV-0042', status: 'PART_PAID', issued: true },
      }),
      'CANCELLED',
    );
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_LOCKED' });
    if (!result.ok) expect(result.message).toContain('credit note');
  });

  it('sends a draft invoice back to the invoice rather than to a credit note', () => {
    // Nothing has gone to the client yet, so there is nothing to credit. The
    // line still has to come off, or the draft goes out billing for work that
    // was cancelled underneath it.
    const result = canTransition(
      job({
        status: 'COMPLETED',
        lockedByInvoice: { reference: 'INV-0043', status: 'DRAFT', issued: false },
      }),
      'CANCELLED',
    );
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_LOCKED' });
    if (!result.ok) {
      expect(result.message).toContain('INV-0043');
      expect(result.message).toContain('Remove it from that invoice');
      expect(result.message).not.toContain('credit note');
    }
  });
});

describe('pricing predicates', () => {
  it('treats a positive price as priced', () => {
    expect(hasPriceOrReason({ clientPricePence: 1, zeroValueReason: null })).toBe(true);
  });

  it('treats null, zero and blank reasons as unpriced', () => {
    expect(hasPriceOrReason({ clientPricePence: null, zeroValueReason: null })).toBe(false);
    expect(hasPriceOrReason({ clientPricePence: 0, zeroValueReason: '' })).toBe(false);
    expect(hasPriceOrReason({ clientPricePence: 0, zeroValueReason: ' ' })).toBe(false);
  });

  it('flags an unpriced job for the dashboard tile', () => {
    expect(
      isUnpriced({ status: 'COMPLETED', clientPricePence: null, zeroValueReason: null }),
    ).toBe(true);
    expect(
      isUnpriced({ status: 'COMPLETED', clientPricePence: 5000, zeroValueReason: null }),
    ).toBe(false);
  });

  it('rejects a negative price rather than counting it as priced', () => {
    expect(hasPriceOrReason({ clientPricePence: -100, zeroValueReason: null })).toBe(false);
  });
});

describe('status metadata', () => {
  it('labels every status', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
    }
  });

  it('records an event for every status a job can be moved to', () => {
    // DRAFT and PENDING are entry states — the CREATED event covers those.
    for (const status of ALL_STATUSES) {
      const expected = status === 'DRAFT' || status === 'PENDING';
      expect(eventTypeForStatus(status) === null, status).toBe(expected);
    }
  });
});

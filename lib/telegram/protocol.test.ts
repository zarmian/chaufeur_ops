import { describe, expect, it } from 'vitest';
import {
  canTake,
  decodeCallback,
  encodeCallback,
  escapeMarkdown,
  DELAY_CHOICES,
  linkPayload,
  mapLink,
  nextStep,
  parseAmountFromChat,
  parseStartPayload,
  renderBrief,
  renderChanges,
} from './protocol';

/**
 * What a tap means.
 *
 * The rules worth guarding are all about a message arriving later than
 * expected. Telegram redelivers, drivers double-tap, and a button on a
 * three-week-old message looks exactly like a fresh one — so the same tap
 * twice must be harmless, and a tap out of order must be refused with
 * something a driver standing in a car park can act on.
 */

describe('nextStep', () => {
  it('walks the sequence', () => {
    expect(nextStep([])).toBe('ON_WAY');
    expect(nextStep(['ON_WAY'])).toBe('ARRIVED');
    expect(nextStep(['ON_WAY', 'ARRIVED'])).toBe('POB');
    expect(nextStep(['ON_WAY', 'ARRIVED', 'POB'])).toBe('COMPLETED');
    expect(nextStep(['ON_WAY', 'ARRIVED', 'POB', 'COMPLETED'])).toBeNull();
  });

  it('ignores events that are not driver steps', () => {
    // A job carries CREATED, ASSIGNED and PRICE_SET too.
    expect(nextStep(['CREATED', 'ASSIGNED', 'ACCEPTED'])).toBe('ON_WAY');
  });
});

describe('canTake', () => {
  it('allows the next step', () => {
    expect(canTake('ON_WAY', ['ACCEPTED'])).toEqual({ ok: true });
  });

  it('accepts a repeat quietly, because Telegram redelivers', () => {
    // A double-tap is not a mistake worth a telling-off, and the handler
    // makes it a no-op.
    expect(canTake('ON_WAY', ['ON_WAY'])).toEqual({ ok: true });
  });

  it('refuses a skipped step and says which one is missing', () => {
    const verdict = canTake('POB', ['ON_WAY']);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('Arrived');
  });

  it('refuses anything once the job is finished', () => {
    const verdict = canTake('ARRIVED', ['ON_WAY', 'ARRIVED', 'POB', 'COMPLETED']);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('already finished');
  });
});

describe('callbacks', () => {
  it('round-trips every kind', () => {
    const cases = [
      { kind: 'accept', jobId: 'job-1' },
      { kind: 'decline', jobId: 'job-1' },
      { kind: 'step', jobId: 'job-1', step: 'ARRIVED' },
      { kind: 'expense-kind', expenseId: 'exp-1', expenseKind: 'PARKING' },
      { kind: 'expense-cancel', expenseId: 'exp-1' },
    ] as const;

    for (const callback of cases) {
      expect(decodeCallback(encodeCallback(callback))).toEqual(callback);
    }
  });

  it('fits inside Telegram’s 64-byte limit for a real id', () => {
    const data = encodeCallback({
      kind: 'step',
      jobId: 'cmshcnqbm003h7d2ig276yx21',
      step: 'COMPLETED',
    });
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('returns null for anything it does not recognise', () => {
    for (const data of ['', 'nonsense', 'job:only-two', 'job::accept', 'job:1:teleport']) {
      expect(decodeCallback(data)).toBeNull();
    }
  });
});

describe('parseStartPayload', () => {
  it('reads a driver link token', () => {
    expect(parseStartPayload('/start drv_abc123XYZ_-def')).toEqual({
      audience: 'driver',
      token: 'abc123XYZ_-def',
    });
  });

  it('reads a staff link token', () => {
    expect(parseStartPayload('/start stf_abc123XYZ_-def')).toEqual({
      audience: 'staff',
      token: 'abc123XYZ_-def',
    });
  });

  it('reads it when the command names the bot', () => {
    // Group chats append the bot's username.
    expect(parseStartPayload('/start@AnyOpsBot drv_abc123XYZ')).toEqual({
      audience: 'driver',
      token: 'abc123XYZ',
    });
  });

  it('is null for a bare start or an unrelated payload', () => {
    // Not "expired" — there was no token, and reporting one as expired sends
    // the driver to ops for a replacement they do not need.
    expect(parseStartPayload('/start')).toBeNull();
    expect(parseStartPayload('/start referral_99')).toBeNull();
    expect(parseStartPayload('/start drv_short')).toBeNull();
    expect(parseStartPayload('/start stf_short')).toBeNull();
  });

  it('does not confuse the two prefixes', () => {
    /*
     * The distinction the whole prefix exists for. A staff token redeemed as
     * a driver link would bind an office phone to a driver record — their
     * jobs, and their pay. The reverse hands a driver the commands that show
     * revenue. Neither is recoverable by the person it happens to.
     */
    const staff = parseStartPayload('/start stf_abcdefgh12345678');
    const driver = parseStartPayload('/start drv_abcdefgh12345678');
    expect(staff?.audience).toBe('staff');
    expect(driver?.audience).toBe('driver');
    expect(staff?.token).toBe(driver?.token);
  });

  it('matches what linkPayload builds, for either audience', () => {
    expect(parseStartPayload(`/start ${linkPayload('abcdefgh12345678')}`)).toEqual({
      audience: 'driver',
      token: 'abcdefgh12345678',
    });
    expect(
      parseStartPayload(`/start ${linkPayload('abcdefgh12345678', 'staff')}`),
    ).toEqual({ audience: 'staff', token: 'abcdefgh12345678' });
  });
});

describe('parseAmountFromChat', () => {
  it.each([
    ['12.50', 1250],
    ['£12.50', 1250],
    ['12,50', 1250],
    ['12', 1200],
    [' 8.05 ', 805],
    ['1,234.50', 123_450],
  ])('%s is %i pence', (input, expected) => {
    expect(parseAmountFromChat(input)).toBe(expected);
  });

  it('returns null rather than zero for anything it cannot read', () => {
    // A zero-value expense is indistinguishable from a parse failure, and
    // would go into the payout as nothing.
    for (const input of ['', 'about a tenner', '0', '0.00', '-5', '1.234', 'abc']) {
      expect(parseAmountFromChat(input)).toBeNull();
    }
  });
});

describe('escapeMarkdown', () => {
  it('escapes what would otherwise break the whole message', () => {
    // Telegram rejects malformed MarkdownV2 outright, so an unescaped
    // underscore in a name means the driver gets nothing at all.
    expect(escapeMarkdown('Ms. O_Brien-Smith (VIP)')).toBe(
      'Ms\\. O\\_Brien\\-Smith \\(VIP\\)',
    );
  });
});

describe('renderBrief', () => {
  const brief = {
    reference: 'JOB-000123',
    when: 'Tue 7 Apr, 14:30',
    pickup: 'The Dorchester',
    dropoff: 'Heathrow Terminal 5',
    passenger: 'Ms Harding',
    vehicle: 'LM19 TRT — Mercedes E-Class',
    flightNumber: 'BA286',
    notes: 'Meet at the front desk',
    driverPay: '£85.00',
  };

  it('leads with the reference and the time', () => {
    const text = renderBrief(brief);
    expect(text.split('\n')[0]).toContain('JOB\\-000123');
    expect(text).toContain('14:30');
  });

  it('carries everything the driver needs at the kerb', () => {
    const text = renderBrief(brief);
    for (const fragment of ['Dorchester', 'Heathrow', 'BA286', 'Harding', 'LM19']) {
      expect(text).toContain(fragment);
    }
  });

  it('leaves out what has not been given', () => {
    const text = renderBrief({
      ...brief,
      flightNumber: null,
      notes: null,
      passenger: null,
      vehicle: null,
      driverPay: null,
    });
    expect(text).not.toContain('✈️');
    expect(text).not.toContain('👤');
    expect(text).not.toContain('💷');
  });

  it('shows the steps already taken, so the message can be edited in place', () => {
    const text = renderBrief({ ...brief, recorded: ['ON_WAY', 'ARRIVED'] });
    expect(text).toContain('On my way');
    expect(text).toContain('Arrived');
    expect(text).not.toContain('Passenger on board');
  });
});

describe('renderChanges', () => {
  it('says what moved, not just that something did', () => {
    const text = renderChanges('JOB-000123', [
      { field: 'Pickup time', from: '14:30', to: '15:15' },
    ]);
    expect(text).toContain('JOB\\-000123');
    expect(text).toContain('14:30');
    expect(text).toContain('15:15');
  });

  it('is empty when nothing changed', () => {
    expect(renderChanges('JOB-000123', [])).toBe('');
  });
});

describe('the running-late buttons', () => {
  it('round-trips a delay through the callback data', () => {
    for (const minutes of DELAY_CHOICES) {
      const encoded = encodeCallback({ kind: 'late-eta', jobId: 'job_1', minutes });
      expect(encoded.length, encoded).toBeLessThanOrEqual(64);
      expect(decodeCallback(encoded)).toEqual({
        kind: 'late-eta',
        jobId: 'job_1',
        minutes,
      });
    }
  });

  it('round-trips the tap that opens the choices', () => {
    expect(decodeCallback(encodeCallback({ kind: 'late', jobId: 'job_1' }))).toEqual({
      kind: 'late',
      jobId: 'job_1',
    });
  });

  it('refuses a delay that was never offered', () => {
    /*
     * Callback data is whatever the client sends. An unoffered number would
     * otherwise be recorded as the driver's own estimate and alerted to ops as
     * fact — "7 hours late" from a tampered button, or from a keyboard left
     * over from a build with different choices.
     */
    expect(decodeCallback('late:job_1:7')).toBeNull();
    expect(decodeCallback('late:job_1:999')).toBeNull();
    expect(decodeCallback('late:job_1:abc')).toBeNull();
    expect(decodeCallback('late:job_1:-5')).toBeNull();
  });

  it('fits a real cuid inside Telegram’s 64 bytes', () => {
    const cuid = 'cmsxky07w008e7d6lqth1kmkx';
    expect(encodeCallback({ kind: 'late', jobId: cuid }).length).toBeLessThanOrEqual(64);
    expect(
      encodeCallback({ kind: 'late-eta', jobId: cuid, minutes: 45 }).length,
    ).toBeLessThanOrEqual(64);
  });
});

describe('the map link', () => {
  it('prefers coordinates', () => {
    // A postcode drops a pin at the centre of a delivery area, and an airport
    // terminal is nowhere near where its postcode says.
    expect(mapLink({ lat: 51.47, lng: -0.4543, postcode: 'TW6 1AP', text: 'Heathrow T5' }))
      .toBe('https://www.google.com/maps/search/?api=1&query=51.47,-0.4543');
  });

  it('falls back to the address and postcode together', () => {
    expect(mapLink({ text: 'The Dorchester', postcode: 'W1K 1QA' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=The%20Dorchester%20W1K%201QA',
    );
  });

  it('ignores half a coordinate pair', () => {
    // A latitude with no longitude is not a place.
    expect(mapLink({ lat: 51.47, lng: null, text: 'Heathrow' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=Heathrow',
    );
  });

  it('is null when there is nowhere to point at', () => {
    expect(mapLink({})).toBeNull();
    expect(mapLink({ text: '   ' })).toBeNull();
  });
});

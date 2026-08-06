import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  revolutPaymentFrom,
  verifyRevolutSignature,
} from './revolut';
import {
  sumUpPaymentFrom,
  toMajorUnits,
  toPence,
  verifySumUpSignature,
} from './sumup';
import {
  blankGatewayConfig,
  environmentWarning,
  gatewayUsable,
} from './types';

/**
 * The parts of a payment gateway that must be right.
 *
 * A webhook endpoint has no session behind it: the signature check is the
 * whole of its security, and an accepted forgery marks an invoice paid that
 * nobody paid. So the verification is tested for what it rejects rather than
 * only for what it accepts.
 *
 * The other half is the money. SumUp speaks in decimal pounds where this
 * system speaks in integer pence, and that conversion is the one place a
 * float touches the money path.
 */

const SECRET = 'whsec_test_1234567890';

describe('Revolut webhook signatures', () => {
  const body = JSON.stringify({ event: 'ORDER_COMPLETED', order: { id: 'o1' } });
  const now = new Date('2026-08-05T12:00:00Z');
  const timestamp = String(now.getTime());

  function sign(payload: string, at = timestamp): string {
    return createHmac('sha256', SECRET).update(`v1.${at}.${payload}`).digest('hex');
  }

  it('accepts a correctly signed request', () => {
    expect(
      verifyRevolutSignature({
        rawBody: body,
        signatureHeader: `v1=${sign(body)}`,
        timestampHeader: timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(true);
  });

  it('accepts a header carrying several versions', () => {
    expect(
      verifyRevolutSignature({
        rawBody: body,
        signatureHeader: `v0=deadbeef,v1=${sign(body)}`,
        timestampHeader: timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    // The single most important case: an attacker who can replay a signature
    // must not be able to alter the amount it covers.
    const tampered = JSON.stringify({
      event: 'ORDER_COMPLETED',
      order: { id: 'o1', amount: 999999 },
    });

    expect(
      verifyRevolutSignature({
        rawBody: tampered,
        signatureHeader: `v1=${sign(body)}`,
        timestampHeader: timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const wrong = createHmac('sha256', 'whsec_someone_else')
      .update(`v1.${timestamp}.${body}`)
      .digest('hex');

    expect(
      verifyRevolutSignature({
        rawBody: body,
        signatureHeader: `v1=${wrong}`,
        timestampHeader: timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a replay from outside the tolerance', () => {
    // A signature is otherwise valid forever, so a captured request could be
    // posted again and again to record the same payment repeatedly.
    const old = String(now.getTime() - 20 * 60 * 1000);

    expect(
      verifyRevolutSignature({
        rawBody: body,
        signatureHeader: `v1=${sign(body, old)}`,
        timestampHeader: old,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a request with no signature or no timestamp at all', () => {
    for (const headers of [
      { signatureHeader: null, timestampHeader: timestamp },
      { signatureHeader: `v1=${sign(body)}`, timestampHeader: null },
      { signatureHeader: null, timestampHeader: null },
    ]) {
      expect(
        verifyRevolutSignature({ rawBody: body, secret: SECRET, now, ...headers }),
      ).toBe(false);
    }
  });

  it('rejects a non-numeric timestamp rather than treating it as now', () => {
    expect(
      verifyRevolutSignature({
        rawBody: body,
        signatureHeader: `v1=${sign(body, 'soon')}`,
        timestampHeader: 'soon',
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });
});

describe('SumUp webhook signatures', () => {
  const body = JSON.stringify({ id: 'c1', payload: { status: 'PAID' } });

  function sign(payload: string, secret = SECRET): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  it('accepts a correctly signed request, with or without the prefix', () => {
    for (const header of [sign(body), `sha256=${sign(body)}`]) {
      expect(
        verifySumUpSignature({
          rawBody: body,
          signatureHeader: header,
          secret: SECRET,
        }),
      ).toBe(true);
    }
  });

  it('rejects a tampered body', () => {
    expect(
      verifySumUpSignature({
        rawBody: JSON.stringify({ id: 'c1', payload: { status: 'PAID', amount: 9999 } }),
        signatureHeader: sign(body),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a signature from a different secret, and a missing header', () => {
    expect(
      verifySumUpSignature({
        rawBody: body,
        signatureHeader: sign(body, 'other'),
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifySumUpSignature({ rawBody: body, signatureHeader: null, secret: SECRET }),
    ).toBe(false);
  });
});

describe('SumUp money conversion', () => {
  it.each([
    [12_550, 125.5],
    [8000, 80],
    [1, 0.01],
    [0, 0],
  ])('%i pence is %s in major units', (pence, major) => {
    expect(toMajorUnits(pence)).toBe(major);
  });

  it.each([
    ['125.50', 12_550],
    ['80', 8000],
    [0.01, 1],
    [125.5, 12_550],
  ])('%s comes back as %i pence', (major, pence) => {
    expect(toPence(major)).toBe(pence);
  });

  it('round-trips without losing a penny', () => {
    // The one place a float touches money. `2.675 * 100` is 267.49999999999997
    // in IEEE 754, and a truncating conversion would lose a penny on amounts
    // like this one.
    for (const pence of [1, 99, 267, 12_550, 99_999, 1_234_567]) {
      expect(toPence(toMajorUnits(pence))).toBe(pence);
    }
  });

  it('treats nonsense as nothing rather than NaN', () => {
    expect(toPence('not a number')).toBe(0);
  });
});

describe('reading a Revolut event', () => {
  it('takes the invoice id from metadata, never from the amount', () => {
    const payment = revolutPaymentFrom({
      event: 'ORDER_COMPLETED',
      order: {
        id: 'ord_1',
        amount: 15_060,
        currency: 'GBP',
        completed_at: '2026-08-05T12:00:00Z',
        metadata: { invoiceId: 'inv_1' },
      },
    });

    expect(payment).not.toBeNull();
    expect(payment?.invoiceId).toBe('inv_1');
    expect(payment?.amountPence).toBe(15_060);
    expect(payment?.status).toBe('received');
  });

  it('marks anything that is not a completion as pending', () => {
    const payment = revolutPaymentFrom({
      event: 'ORDER_AUTHORISED',
      order: { id: 'ord_2', amount: 100 },
    });
    expect(payment?.status).toBe('pending');
  });

  it('ignores an event it does not handle', () => {
    expect(revolutPaymentFrom({ event: 'PAYOUT_CREATED' })).toBeNull();
    expect(revolutPaymentFrom({ event: 'ORDER_COMPLETED' })).toBeNull();
    expect(revolutPaymentFrom(null)).toBeNull();
    expect(revolutPaymentFrom('nonsense')).toBeNull();
  });
});

describe('reading a SumUp event', () => {
  it('converts the amount back to pence and carries the reference', () => {
    const payment = sumUpPaymentFrom({
      payload: {
        id: 'chk_1',
        status: 'PAID',
        amount: 150.6,
        currency: 'GBP',
        checkout_reference: 'inv_1',
        date: '2026-08-05T12:00:00Z',
      },
    });

    expect(payment?.invoiceId).toBe('inv_1');
    expect(payment?.amountPence).toBe(15_060);
    expect(payment?.status).toBe('received');
  });

  it('marks a failure as failed rather than pending', () => {
    const payment = sumUpPaymentFrom({
      payload: { id: 'chk_2', status: 'FAILED', amount: 10 },
    });
    expect(payment?.status).toBe('failed');
  });

  it('ignores a body with no id', () => {
    expect(sumUpPaymentFrom({ payload: { status: 'PAID' } })).toBeNull();
  });
});

describe('gateway configuration', () => {
  it('is unusable until it is enabled and keyed', () => {
    const config = blankGatewayConfig('revolut');
    expect(gatewayUsable(config)).toBe(false);
    expect(gatewayUsable({ ...config, enabled: true })).toBe(false);
    expect(gatewayUsable({ ...config, enabled: true, apiKey: 'k' })).toBe(true);
  });

  it('needs a merchant code for SumUp specifically', () => {
    const config = { ...blankGatewayConfig('sumup'), enabled: true, apiKey: 'k' };
    expect(gatewayUsable(config)).toBe(false);
    expect(gatewayUsable({ ...config, merchantCode: 'MC1' })).toBe(true);
  });

  it('warns about production, and about SumUp having no real sandbox', () => {
    const revolut = blankGatewayConfig('revolut');
    expect(environmentWarning(revolut)).toBeNull();
    expect(environmentWarning({ ...revolut, environment: 'production' })).toContain(
      'real cards',
    );

    expect(environmentWarning(blankGatewayConfig('sumup'))).toContain(
      'no separate sandbox',
    );
  });

  it('warns before the gateway is enabled, not after', () => {
    // A warning that appeared only once production was on would arrive one
    // step too late to be a warning.
    const off = { ...blankGatewayConfig('revolut'), environment: 'production' as const };
    expect(off.enabled).toBe(false);
    expect(environmentWarning(off)).toContain('real cards');
  });
});

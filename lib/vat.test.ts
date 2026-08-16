import { describe, expect, it } from 'vitest';
import {
  backOutTax,
  disbursementPenceOf,
  invoiceTax,
  lineTax,
  resolveVatTreatment,
  type TaxableLine,
} from './vat';

/**
 * The tax rules, which are the part of invoicing that must never be wrong.
 *
 * Three of these are money the company either loses or wrongly charges:
 * adding tax to a price that already contains it, adding it to a car park fee
 * paid on the client's behalf, and adding it to work that is not
 * tax-qualifying at all. The fourth — grouping before rounding — is the one
 * that makes the printed document add up to itself.
 */

const standard = (amountPence: number, disbursementPence = 0): TaxableLine => ({
  amountPence,
  disbursementPence,
  treatment: 'STANDARD',
});

describe('lineTax', () => {
  it('adds tax on top of an agreed price', () => {
    expect(lineTax(standard(10_000), 20)).toEqual({
      netPence: 10_000,
      disbursementPence: 0,
      taxPence: 2000,
      grossPence: 12_000,
    });
  });

  it('backs tax out of a price that already contains it', () => {
    // £120 inclusive is £100 and £20. Charging £144 asks the client for 20%
    // they have already paid.
    expect(lineTax({ amountPence: 12_000, treatment: 'INCLUSIVE' }, 20)).toEqual({
      netPence: 10_000,
      disbursementPence: 0,
      taxPence: 2000,
      grossPence: 12_000,
    });
  });

  it('adds nothing to work that is not tax-qualifying', () => {
    expect(lineTax({ amountPence: 10_000, treatment: 'EXEMPT' }, 20)).toEqual({
      netPence: 10_000,
      disbursementPence: 0,
      taxPence: 0,
      grossPence: 10_000,
    });
  });

  it('never taxes the pass-through part, under any treatment', () => {
    // A £90 fare with £7.50 of car park bears tax on the £90 only.
    expect(lineTax(standard(9750, 750), 20)).toEqual({
      netPence: 9000,
      disbursementPence: 750,
      taxPence: 1800,
      grossPence: 11_550,
    });

    // Inclusive: only the fare part is unwound, and the car park comes
    // through untouched.
    expect(
      lineTax({ amountPence: 12_750, disbursementPence: 750, treatment: 'INCLUSIVE' }, 20),
    ).toEqual({
      netPence: 10_000,
      disbursementPence: 750,
      taxPence: 2000,
      grossPence: 12_750,
    });
  });
});

describe('backOutTax', () => {
  it('is the inverse of adding it', () => {
    expect(backOutTax(12_000, 20)).toBe(10_000);
    expect(backOutTax(11_900, 19)).toBe(10_000);
  });

  it('is a no-op at a zero rate', () => {
    expect(backOutTax(12_000, 0)).toBe(12_000);
  });

  it('mirrors itself for a credit note', () => {
    // `roundPence` is half away from zero, so negating the input negates the
    // output exactly — a credit note lands on the same penny as the invoice
    // it reverses rather than a penny beside it.
    expect(backOutTax(-12_050, 20)).toBe(-backOutTax(12_050, 20));
  });
});

describe('invoiceTax', () => {
  it('rounds once per treatment, not once per line', () => {
    // Twenty lines of £10.99 at 20% round to £2.20 each — £44.00 — where the
    // right figure on £219.80 is £43.96. Both are acceptable to a tax
    // authority; only one survives somebody adding the column up.
    const lines = Array.from({ length: 20 }, () => standard(1099));
    const tax = invoiceTax(lines, 20);
    expect(tax.netPence).toBe(21_980);
    expect(tax.taxPence).toBe(4396);
    expect(tax.grossPence).toBe(26_376);
  });

  it('keeps the treatments in separate bands', () => {
    const tax = invoiceTax(
      [
        standard(10_000),
        { amountPence: 12_000, treatment: 'INCLUSIVE' },
        { amountPence: 5000, treatment: 'EXEMPT' },
      ],
      20,
    );

    expect(tax.bands.map((band) => band.treatment)).toEqual([
      'STANDARD',
      'INCLUSIVE',
      'EXEMPT',
    ]);
    // £100 net + £20 tax; £120 inclusive is £100 net + £20 tax; £50 untaxed.
    expect(tax.netPence).toBe(25_000);
    expect(tax.taxPence).toBe(4000);
    // The inclusive line adds nothing, so gross is 120 + 120 + 50.
    expect(tax.grossPence).toBe(29_000);
  });

  it('is the worked example from the invoices being replaced', () => {
    // £5,200 hire plus £75 of congestion charges. Tax is £1,040 — 20% of the
    // hire alone — and the total is £6,315. Taxing the congestion too would
    // give £1,055 and £6,330, which is what a single invoice-wide rate did.
    const tax = invoiceTax([standard(527_500, 7500)], 20);
    expect(tax.netPence).toBe(527_500);
    expect(tax.disbursementPence).toBe(7500);
    expect(tax.taxPence).toBe(104_000);
    expect(tax.grossPence).toBe(631_500);
  });

  it('has no bands at all when there are no lines', () => {
    expect(invoiceTax([], 20)).toEqual({
      netPence: 0,
      taxPence: 0,
      grossPence: 0,
      disbursementPence: 0,
      bands: [],
    });
  });

  it('reverses cleanly for a credit note', () => {
    const lines: TaxableLine[] = [standard(9750, 750)];
    const forward = invoiceTax(lines, 20);
    const back = invoiceTax(
      lines.map((line) => ({
        ...line,
        amountPence: -line.amountPence,
        disbursementPence: -(line.disbursementPence ?? 0),
      })),
      20,
    );

    expect(back.netPence).toBe(-forward.netPence);
    expect(back.taxPence).toBe(-forward.taxPence);
    expect(back.grossPence).toBe(-forward.grossPence);
  });
});

describe('disbursementPenceOf', () => {
  it('counts parking and drop-off charges the client is being charged', () => {
    expect(
      disbursementPenceOf([
        { kind: 'PARKING', amountPence: 750, borneBy: 'CLIENT' },
        { kind: 'DROPOFF_CHARGE', amountPence: 600, borneBy: 'CLIENT' },
        { kind: 'CONGESTION_CHARGE', amountPence: 1500, borneBy: 'CLIENT' },
      ]),
    ).toBe(2850);
  });

  it('leaves out fuel and waiting, which are the operator’s own supply', () => {
    expect(
      disbursementPenceOf([
        { kind: 'FUEL', amountPence: 4000, borneBy: 'CLIENT' },
        { kind: 'WAITING', amountPence: 2500, borneBy: 'CLIENT' },
      ]),
    ).toBe(0);
  });

  it('leaves out anything the client is not being charged for', () => {
    // Shrinking the tax base by an expense the company or the driver swallowed
    // would exempt money the client was never asked for.
    expect(
      disbursementPenceOf([
        { kind: 'PARKING', amountPence: 750, borneBy: 'COMPANY' },
        { kind: 'PARKING', amountPence: 300, borneBy: 'DRIVER' },
      ]),
    ).toBe(0);
  });
});

describe('resolveVatTreatment', () => {
  it('takes the first answer anybody gave', () => {
    expect(resolveVatTreatment(null, 'EXEMPT', 'STANDARD')).toBe('EXEMPT');
    expect(resolveVatTreatment('INCLUSIVE', 'EXEMPT')).toBe('INCLUSIVE');
  });

  it('assumes tax is added when nobody has said', () => {
    // The safe direction: undercharging tax is the company's loss, and it is
    // the one an accountant discovers late.
    expect(resolveVatTreatment(null, undefined)).toBe('STANDARD');
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildJobLine,
  buildRentalLine,
  jobLineText,
  splitLineText,
} from './invoice-lines';

/**
 * What an invoice line says.
 *
 * The operator's complaint: the invoice listed job numbers and nothing else.
 * A line now carries the same facts the jobs list shows, snapshotted when the
 * line is added — a sent invoice must not change because somebody later fixes
 * a typo in a pickup address.
 */

const at = (iso: string) => new Date(iso);

const job = {
  reference: 'JOB-000123',
  jobType: 'AIRPORT_TRANSFER',
  scheduledAt: at('2026-05-14T09:30:00Z'),
  pickupText: 'London Heathrow Terminal 3',
  dropoffText: 'The Marylebone Hotel, 47 Welbeck Street',
};

describe('jobLineText', () => {
  it('reads as a booking, not a reference', () => {
    expect(jobLineText(job)).toEqual([
      'Airport transfer · JOB-000123',
      '14 May 2026, 10:30',
      'Pick up: London Heathrow Terminal 3',
      'Drop off: The Marylebone Hotel, 47 Welbeck Street',
    ]);
  });

  it('adds the things that only some jobs have', () => {
    const text = jobLineText({
      ...job,
      viaText: 'Claridge’s',
      flightNumber: 'BA286',
      passengerName: 'Ms Adeyemi',
    });
    expect(text).toContain('Via: Claridge’s');
    expect(text).toContain('Flight: BA286');
    expect(text).toContain('Passenger: Ms Adeyemi');
  });

  it('prints the pickup in the operator’s timezone, not UTC', () => {
    // 09:30 UTC in May is 10:30 in London. Getting this wrong puts a driver
    // at the terminal an hour out, twice a year.
    expect(jobLineText(job)[1]).toBe('14 May 2026, 10:30');
  });
});

describe('splitLineText', () => {
  it('recovers the title and the detail a line was stored with', () => {
    const { title, details } = splitLineText(
      'Airport transfer · JOB-000123\n14 May 2026, 10:30\nPick up: T3',
    );
    expect(title).toBe('Airport transfer · JOB-000123');
    expect(details).toEqual(['14 May 2026, 10:30', 'Pick up: T3']);
  });

  it('survives a line with no detail at all', () => {
    expect(splitLineText('Waiting time')).toEqual({
      title: 'Waiting time',
      details: [],
    });
  });
});

describe('buildJobLine', () => {
  it('shows a transfer as one trip at its fare', () => {
    const line = buildJobLine({ job, amountPence: 9000 });
    expect(line.quantity).toBe(1);
    expect(line.quantityUnit).toBe('trip');
    expect(line.unitPricePence).toBe(9000);
    expect(line.amountPence).toBe(9000);
  });

  it('shows an as-directed job as hours at a rate', () => {
    const line = buildJobLine({
      job: {
        ...job,
        jobType: 'AS_DIRECTED',
        finance: { customerHours: 10, customerRatePence: 14_000 },
      },
      amountPence: 140_000,
    });
    expect(line.quantity).toBe(10);
    expect(line.quantityUnit).toBe('hrs');
    expect(line.unitPricePence).toBe(14_000);
  });

  it('shows a contract as days at a day rate', () => {
    const line = buildJobLine({
      job: {
        ...job,
        jobType: 'CONTRACT',
        finance: { customerDays: 5, customerDayRatePence: 40_000 },
      },
      amountPence: 200_000,
    });
    expect(line.quantity).toBe(5);
    expect(line.quantityUnit).toBe('days');
    expect(line.unitPricePence).toBe(40_000);
    expect(splitLineText(line.description).title).toBe(
      'Contract hire \u00b7 JOB-000123',
    );
  });

  it('says day, not days, for a one-day contract', () => {
    const line = buildJobLine({
      job: {
        ...job,
        jobType: 'CONTRACT',
        finance: { customerDays: 1, customerDayRatePence: 40_000 },
      },
      amountPence: 40_000,
    });
    expect(line.quantityUnit).toBe('day');
  });

  it('drops the day columns when they would not multiply out', () => {
    // A contract billed for days *and* a recharged expense cannot honestly
    // print "5 days at £400" beside a larger total.
    const line = buildJobLine({
      job: {
        ...job,
        jobType: 'CONTRACT',
        finance: { customerDays: 5, customerDayRatePence: 40_000 },
      },
      amountPence: 201_500,
    });
    expect(line.quantityUnit).toBe('trip');
    expect(line.unitPricePence).toBe(201_500);
  });

  it('drops the hourly columns when they would not multiply out', () => {
    // A job billed for hours *and* something else cannot honestly print
    // "10 hrs at £140" beside a larger total — the client would query it.
    const line = buildJobLine({
      job: {
        ...job,
        jobType: 'AS_DIRECTED',
        finance: { customerHours: 10, customerRatePence: 14_000 },
      },
      amountPence: 145_000,
    });
    expect(line.quantityUnit).toBe('trip');
    expect(line.unitPricePence).toBe(145_000);
  });

  it('keeps parking and drop-off charges out of the tax base', () => {
    const line = buildJobLine({
      job: {
        ...job,
        expenses: [
          { kind: 'PARKING', amountPence: 750, borneBy: 'CLIENT' },
          { kind: 'DROPOFF_CHARGE', amountPence: 600, borneBy: 'CLIENT' },
          // Not passed through, and not the client's anyway.
          { kind: 'FUEL', amountPence: 4000, borneBy: 'CLIENT' },
          { kind: 'PARKING', amountPence: 900, borneBy: 'COMPANY' },
        ],
      },
      amountPence: 10_350,
    });
    expect(line.disbursementPence).toBe(1350);
  });

  it('takes the treatment from the job, then whoever is billed', () => {
    expect(
      buildJobLine({ job: { ...job, vatTreatment: 'EXEMPT' }, amountPence: 1 })
        .vatTreatment,
    ).toBe('EXEMPT');

    // The booker outranks the passenger: the booker is who gets the invoice.
    expect(
      buildJobLine({
        job: {
          ...job,
          account: { vatTreatment: 'INCLUSIVE' },
          client: { vatTreatment: 'EXEMPT' },
        },
        amountPence: 1,
      }).vatTreatment,
    ).toBe('INCLUSIVE');

    expect(buildJobLine({ job, amountPence: 1 }).vatTreatment).toBe('STANDARD');
  });
});

describe('buildRentalLine', () => {
  const rental = {
    reference: 'RNT-000042',
    startAt: at('2026-07-28T19:00:00Z'),
    endAt: at('2026-08-02T10:00:00Z'),
    rateType: 'DAILY',
    ratePence: 20_000,
    vehicle: {
      registration: 'LC24 YNH',
      make: 'Land Rover',
      model: 'Range Rover',
    },
  };

  it('names the car and the hirer', () => {
    const line = buildRentalLine({
      rental,
      renterName: 'Montclares',
      periods: 26,
      amountPence: 520_000,
    });
    const { title, details } = splitLineText(line.description);
    expect(title).toBe('Vehicle hire · RNT-000042');
    expect(details[0]).toBe('Land Rover Range Rover — LC24 YNH');
    expect(details).toContain('Hirer: Montclares');
  });

  it('shows days at a rate when that is what the figure is', () => {
    const line = buildRentalLine({
      rental,
      renterName: 'Montclares',
      periods: 26,
      amountPence: 520_000,
    });
    expect(line.quantity).toBe(26);
    expect(line.quantityUnit).toBe('days');
    expect(line.unitPricePence).toBe(20_000);
  });

  it('drops the columns on a hire already part-settled in cash', () => {
    // Billing the remainder of a hire beside "26 days at £200" is a line the
    // client will query, because it is not 26 × £200.
    const line = buildRentalLine({
      rental,
      renterName: 'Montclares',
      periods: 26,
      amountPence: 120_000,
    });
    expect(line.quantity).toBeNull();
    expect(line.unitPricePence).toBeNull();
  });

  it('treats a hire as the operator’s own supply, never a pass-through', () => {
    const line = buildRentalLine({
      rental,
      renterName: 'Montclares',
      periods: 1,
      amountPence: 20_000,
    });
    expect(line.disbursementPence).toBe(0);
  });
});

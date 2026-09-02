import { describe, expect, it } from 'vitest';
import {
  describeVehicle,
  trackingLinkLive,
  trackingView,
  type TrackingJob,
} from './tracking';

/**
 * The page a stranger holding a URL is allowed to see.
 *
 * Two kinds of assertion here and both matter. The first is what a passenger
 * is told at each stage, because the wording is the product — "your car is
 * here" is the whole reason the link exists. The second is what never appears
 * whatever the job holds, and that half is written as its own test rather
 * than trusted to the shape of the view: a field added to `TrackingJob` in a
 * year should have to get past an assertion, not merely past review.
 */

function job(over: Partial<TrackingJob> = {}): TrackingJob {
  return {
    status: 'ASSIGNED',
    scheduledAt: new Date('2026-09-15T08:00:00Z'),
    pickupText: 'The Dorchester, Park Lane',
    dropoffText: 'Heathrow Terminal 5',
    driver: { name: 'Marek Kowalski' },
    vehicle: {
      make: 'Mercedes-Benz',
      model: 'S-Class',
      colour: 'Black',
      registration: 'AB12 CDE',
    },
    lastEvent: null,
    ...over,
  };
}

describe('trackingView', () => {
  it('says a car is booked before anybody is on it', () => {
    const view = trackingView(
      job({ status: 'PENDING', driver: null, vehicle: null }),
    );

    expect(view.stage).toBe('BOOKED');
    expect(view.headline).toBe('Your car is booked');
    expect(view.driverName).toBeNull();
  });

  it('names the driver once one is assigned, but offers no ETA', () => {
    /*
     * The number nobody should be given. A driver who has not set off has a
     * last known position that is their home, their previous job, or nothing
     * — and "42 minutes away" computed from it is a promise the passenger
     * will hold the office to.
     */
    const view = trackingView(job({ status: 'ASSIGNED' }));

    expect(view.stage).toBe('ASSIGNED');
    expect(view.driverName).toBe('Marek Kowalski');
    expect(view.showEta).toBe(false);
  });

  it('offers an ETA only once the driver is actually moving', () => {
    const view = trackingView(
      job({ status: 'IN_PROGRESS', lastEvent: 'ON_WAY' }),
    );

    expect(view.stage).toBe('ON_WAY');
    expect(view.headline).toBe('Your driver is on the way');
    expect(view.showEta).toBe(true);
  });

  it('tells the passenger what to look for when the car arrives', () => {
    const view = trackingView(
      job({ status: 'IN_PROGRESS', lastEvent: 'ARRIVED' }),
    );

    expect(view.stage).toBe('ARRIVED');
    expect(view.headline).toBe('Your car is here');
    expect(view.detail).toContain('Black Mercedes-Benz S-Class');
    expect(view.detail).toContain('AB12 CDE');
    // The car is at the kerb. Counting down to it would be absurd.
    expect(view.showEta).toBe(false);
  });

  it('stops counting down to the pickup once the passenger is aboard', () => {
    // The ETA this page computes is to the *pickup*, which is now behind
    // them. Left on, it would count down to a place they have left.
    const view = trackingView(job({ status: 'IN_PROGRESS', lastEvent: 'POB' }));

    expect(view.stage).toBe('IN_PROGRESS');
    expect(view.headline).toBe('On your way');
    expect(view.detail).toContain('Heathrow Terminal 5');
    expect(view.showEta).toBe(false);
  });

  it('reads the events, not just the status', () => {
    // `IN_PROGRESS` covers setting off, arriving and driving. A passenger
    // cares about the difference; the status column cannot express it.
    const stages = ['ON_WAY', 'ARRIVED', 'POB'].map(
      (lastEvent) =>
        trackingView(job({ status: 'IN_PROGRESS', lastEvent })).stage,
    );
    expect(stages).toEqual(['ON_WAY', 'ARRIVED', 'IN_PROGRESS']);
  });

  it('closes down cleanly when the journey is finished', () => {
    const view = trackingView(
      job({ status: 'COMPLETED', lastEvent: 'COMPLETED' }),
    );

    expect(view.stage).toBe('COMPLETED');
    expect(view.live).toBe(false);
    expect(view.showEta).toBe(false);
  });

  it('shows no car at all against a cancellation', () => {
    // A driver and a registration beside "cancelled" reads as though one is
    // still coming, which is the opposite of what the page is for.
    const view = trackingView(job({ status: 'CANCELLED' }));

    expect(view.stage).toBe('CANCELLED');
    expect(view.headline).toContain('cancelled');
    expect(view.driverName).toBeNull();
    expect(view.vehicle).toBeNull();
    expect(view.live).toBe(false);
  });

  it('treats a no-show as a cancellation rather than a live journey', () => {
    expect(trackingView(job({ status: 'NO_SHOW' })).stage).toBe('CANCELLED');
  });

  /**
   * The half that is about the link being public.
   *
   * Prices, fees and phone numbers are not on `TrackingJob` at all, which is
   * the real defence. This asserts the outcome anyway: whoever widens that
   * type has to come past here.
   */
  it('never emits anything a competitor or a stranger should not have', () => {
    const rendered = JSON.stringify(
      ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].flatMap(
        (status) =>
          [null, 'ON_WAY', 'ARRIVED', 'POB'].map((lastEvent) =>
            trackingView(job({ status, lastEvent })),
          ),
      ),
    );

    // The margin, which a forwarded link would hand to a competitor.
    expect(rendered).not.toMatch(/pricePence|clientPrice|driverPrice|margin/i);
    // An owner-driver's mobile, which would outlive the job on the internet.
    expect(rendered).not.toMatch(/\+?\d{10,}/);
    // Staff notes are written by staff, for staff.
    expect(rendered).not.toMatch(/notes|internal/i);
  });
});

describe('describeVehicle', () => {
  it('leads with the colour, which is what somebody on a pavement sees first', () => {
    expect(
      describeVehicle({
        colour: 'Black',
        make: 'Mercedes-Benz',
        model: 'S-Class',
        registration: 'AB12 CDE',
      }),
    ).toBe('Black Mercedes-Benz S-Class · AB12 CDE');
  });

  it('drops what it does not know rather than saying "Unknown"', () => {
    // A half-filled vehicle record is common. "Unknown Unknown S-Class" reads
    // as a fault in the system rather than a gap in the data.
    expect(
      describeVehicle({
        colour: null,
        make: 'Mercedes-Benz',
        model: null,
        registration: 'AB12 CDE',
      }),
    ).toBe('Mercedes-Benz · AB12 CDE');

    expect(
      describeVehicle({
        colour: null,
        make: null,
        model: null,
        registration: 'AB12 CDE',
      }),
    ).toBe('AB12 CDE');
  });

  it('has nothing to say about a job with no car on it', () => {
    expect(describeVehicle(null)).toBeNull();
  });
});

describe('trackingLinkLive', () => {
  const pickup = new Date('2026-09-15T08:00:00Z');

  it('answers the night before, which is when people check', () => {
    expect(trackingLinkLive(pickup, new Date('2026-09-14T20:00:00Z'))).toBe(
      true,
    );
  });

  it('answers through a long delay', () => {
    // A flight can land four hours late, and the link matters most then.
    expect(trackingLinkLive(pickup, new Date('2026-09-15T13:00:00Z'))).toBe(
      true,
    );
  });

  it('goes quiet once the journey is well past', () => {
    /*
     * A tracking link is not a receipt. Hours later it is a page naming a
     * driver, a car and two addresses, sitting in whatever chat it was
     * forwarded into — useless long before it stops being sensitive.
     */
    expect(trackingLinkLive(pickup, new Date('2026-09-16T02:00:00Z'))).toBe(
      false,
    );
  });

  it('says nothing before the window opens', () => {
    expect(trackingLinkLive(pickup, new Date('2026-09-13T08:00:00Z'))).toBe(
      false,
    );
  });
});

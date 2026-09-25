import { describe, expect, it } from 'vitest';
import {
  describeVehicle,
  driverShown,
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

/**
 * A moment inside the two-hour window, so the stage assertions below are about
 * the stage and not about what time the suite happens to run. Before this
 * change they passed only because the fixture's pickup was already in the past.
 */
const IN_WINDOW = new Date('2026-09-15T07:00:00Z');

describe('trackingView', () => {
  it('says a car is booked before anybody is on it', () => {
    const view = trackingView(
      job({ status: 'PENDING', driver: null, vehicle: null }), IN_WINDOW);

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
    const view = trackingView(job({ status: 'ASSIGNED' }), IN_WINDOW);

    expect(view.stage).toBe('ASSIGNED');
    expect(view.driverName).toBe('Marek Kowalski');
    expect(view.showEta).toBe(false);
  });

  it('offers an ETA only once the driver is actually moving', () => {
    const view = trackingView(
      job({ status: 'IN_PROGRESS', lastEvent: 'ON_WAY' }), IN_WINDOW);

    expect(view.stage).toBe('ON_WAY');
    expect(view.headline).toBe('Your driver is on the way');
    expect(view.showEta).toBe(true);
  });

  it('tells the passenger what to look for when the car arrives', () => {
    const view = trackingView(
      job({ status: 'IN_PROGRESS', lastEvent: 'ARRIVED' }), IN_WINDOW);

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
    const view = trackingView(job({ status: 'IN_PROGRESS', lastEvent: 'POB' }), IN_WINDOW);

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
        trackingView(job({ status: 'IN_PROGRESS', lastEvent }), IN_WINDOW).stage,
    );
    expect(stages).toEqual(['ON_WAY', 'ARRIVED', 'IN_PROGRESS']);
  });

  it('closes down cleanly when the journey is finished', () => {
    const view = trackingView(
      job({ status: 'COMPLETED', lastEvent: 'COMPLETED' }), IN_WINDOW);

    expect(view.stage).toBe('COMPLETED');
    expect(view.live).toBe(false);
    expect(view.showEta).toBe(false);
  });

  it('shows no car at all against a cancellation', () => {
    // A driver and a registration beside "cancelled" reads as though one is
    // still coming, which is the opposite of what the page is for.
    const view = trackingView(job({ status: 'CANCELLED' }), IN_WINDOW);

    expect(view.stage).toBe('CANCELLED');
    expect(view.headline).toContain('cancelled');
    expect(view.driverName).toBeNull();
    expect(view.vehicle).toBeNull();
    expect(view.live).toBe(false);
  });

  it('treats a no-show as a cancellation rather than a live journey', () => {
    expect(trackingView(job({ status: 'NO_SHOW' }), IN_WINDOW).stage).toBe('CANCELLED');
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
            trackingView(job({ status, lastEvent }), IN_WINDOW),
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
  const job = (status: string) => ({ status, scheduledAt: pickup });

  it('answers the night before, which is when people check', () => {
    // The link works from the moment it is issued. What it *says* before the
    // two-hour mark is another question, and `driverShown` decides it.
    expect(trackingLinkLive(job('ASSIGNED'), new Date('2026-09-14T20:00:00Z'))).toBe(
      true,
    );
  });

  it('answers through a long delay', () => {
    // A flight can land four hours late, and the link matters most then.
    expect(trackingLinkLive(job('IN_PROGRESS'), new Date('2026-09-15T13:00:00Z'))).toBe(
      true,
    );
  });

  it('closes the moment the journey is finished', () => {
    /*
     * The rule this was rebuilt around. A tracking link is not a receipt:
     * once the passenger is set down it is a page naming a driver, a car and
     * two addresses, sitting in whatever chat it was forwarded into. The
     * driver tapping Completed is what closes it, which is more precise than
     * any clock — and it closes the thread on the page with it.
     */
    const justAfter = new Date('2026-09-15T08:40:00Z');
    expect(trackingLinkLive(job('IN_PROGRESS'), justAfter)).toBe(true);
    expect(trackingLinkLive(job('COMPLETED'), justAfter)).toBe(false);
    expect(trackingLinkLive(job('NO_SHOW'), justAfter)).toBe(false);
  });

  it('keeps answering a cancelled journey, which is the point of it', () => {
    /*
     * Deliberately not closed. A job called off an hour before the pickup
     * leaves somebody standing on a pavement, and "no car is coming" is the
     * most valuable thing this page ever says. The cancelled view names no
     * driver and no car, so the link carries nothing a finished one would not.
     */
    expect(trackingLinkLive(job('CANCELLED'), new Date('2026-09-15T07:00:00Z'))).toBe(
      true,
    );
  });

  it('expires on the backstop when nobody ever finished the job', () => {
    // A driver who forgets to tap Completed would otherwise leave the page
    // live for ever, and "for ever" is the one answer a forwarded link naming
    // somebody's driver must never have.
    expect(trackingLinkLive(job('IN_PROGRESS'), new Date('2026-09-15T19:30:00Z'))).toBe(
      true,
    );
    expect(trackingLinkLive(job('IN_PROGRESS'), new Date('2026-09-15T21:00:00Z'))).toBe(
      false,
    );
    // …and the backstop applies to a cancellation too.
    expect(trackingLinkLive(job('CANCELLED'), new Date('2026-09-15T21:00:00Z'))).toBe(
      false,
    );
  });

  it('answers well before the pickup, however early the link was sent', () => {
    // There is no longer an opening time. An operator who sends the link at
    // booking must not hand the client a page that 404s until the day.
    expect(trackingLinkLive(job('PENDING'), new Date('2026-09-01T08:00:00Z'))).toBe(
      true,
    );
  });
});

describe('driverShown', () => {
  const pickup = new Date('2026-09-15T08:00:00Z');

  it('holds the crew back until two hours before', () => {
    /*
     * Two reasons, and the second is the one that matters. A crew can change:
     * name a driver at nine in the morning for a six o'clock pickup and any
     * swap afterwards is a passenger looking for the wrong person. And a link
     * is forwarded — the fewer hours an owner-driver's name and registration
     * sit in somebody's group chat, the better.
     */
    expect(driverShown(pickup, new Date('2026-09-14T20:00:00Z'))).toBe(false);
    expect(driverShown(pickup, new Date('2026-09-15T05:59:00Z'))).toBe(false);
  });

  it('shows them from exactly two hours out', () => {
    expect(driverShown(pickup, new Date('2026-09-15T06:00:00Z'))).toBe(true);
  });

  it('keeps showing them once the journey is under way', () => {
    // The passenger is in the car. Hiding the driver at that point would be
    // the page disagreeing with the person sitting in front of them.
    expect(driverShown(pickup, new Date('2026-09-15T08:30:00Z'))).toBe(true);
  });
});

describe('the crew on the view', () => {
  const base = {
    status: 'ASSIGNED',
    pickupText: 'The Savoy',
    dropoffText: 'Heathrow T5',
    driver: { name: 'Marek Kowalski' },
    vehicle: {
      colour: 'Black',
      make: 'Mercedes-Benz',
      model: 'S-Class',
      registration: 'AB12 CDE',
    },
    lastEvent: null,
  };
  const pickup = new Date('2026-09-15T08:00:00Z');

  it('withholds the driver and the car until two hours before', () => {
    const view = trackingView(
      { ...base, scheduledAt: pickup },
      new Date('2026-09-14T20:00:00Z'),
    );

    expect(view.driverName).toBeNull();
    expect(view.vehicle).toBeNull();
    // …and says when they will appear, rather than "shortly". A passenger who
    // reads "shortly" the night before checks again in ten minutes.
    expect(view.detail).toMatch(/two hours before/);
  });

  it('shows them both once inside the window', () => {
    const view = trackingView(
      { ...base, scheduledAt: pickup },
      new Date('2026-09-15T07:00:00Z'),
    );

    expect(view.driverName).toBe('Marek Kowalski');
    expect(view.vehicle).toBe('Black Mercedes-Benz S-Class · AB12 CDE');
  });

  it('holds them back together, never one without the other', () => {
    // A car with no driver beside it is the same puzzle for a passenger as a
    // driver with no car: both invite the call this page exists to prevent.
    const view = trackingView(
      { ...base, scheduledAt: pickup },
      new Date('2026-09-10T08:00:00Z'),
    );

    expect([view.driverName, view.vehicle]).toEqual([null, null]);
  });
});

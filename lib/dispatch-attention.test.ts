import { describe, expect, it } from 'vitest';
import {
  attentionItems,
  DEFAULT_ATTENTION,
  type AttentionJob,
} from './dispatch-attention';
import type { ProgressEvent } from './job-progress';

/**
 * What the board decides to shout about.
 *
 * These are the rules people argue about — how late is late, how close is
 * close — so every boundary is pinned. The one that matters most is the
 * distinction between a driver who has not looked at their phone and one who
 * is quietly getting on with it: both read `ASSIGNED`, and only one of them
 * needs a call.
 */

const NOW = new Date('2026-08-21T12:00:00Z');

/** Minutes from `NOW`; negative is in the past. */
const at = (minutes: number): Date =>
  new Date(NOW.getTime() + minutes * 60_000);

function job(overrides: Partial<AttentionJob> = {}): AttentionJob {
  return {
    id: 'job_1',
    reference: 'WL-0001',
    status: 'PENDING',
    driverId: null,
    scheduledAt: at(60),
    estimatedMinutes: 60,
    customerHours: null,
    ...overrides,
  };
}

const events = (...pairs: [string, number][]): ProgressEvent[] =>
  pairs.map(([type, minutes]) => ({
    type: type as ProgressEvent['type'],
    occurredAt: at(minutes),
  }));

describe('unassigned work', () => {
  it('is quiet about a job days away', () => {
    // Four hours is the window. A booking on Thursday is not a problem yet,
    // and a board that says it is has nothing left to say when it becomes one.
    expect(attentionItems([job({ scheduledAt: at(60 * 24) })], NOW)).toEqual([]);
  });

  it('flags one inside the window as a warning', () => {
    const [item] = attentionItems([job({ scheduledAt: at(90) })], NOW);
    expect(item).toMatchObject({ reason: 'UNASSIGNED', severity: 'warning' });
    expect(item!.minutes).toBe(-90);
  });

  it('turns critical once the pickup has passed', () => {
    // Somebody is standing outside with a bag and no car is coming.
    const [item] = attentionItems([job({ scheduledAt: at(-10) })], NOW);
    expect(item).toMatchObject({ reason: 'UNASSIGNED', severity: 'critical' });
  });

  it('takes the window from the thresholds it is given', () => {
    const eightHoursOut = [job({ scheduledAt: at(60 * 6) })];
    expect(attentionItems(eightHoursOut, NOW)).toEqual([]);
    expect(
      attentionItems(eightHoursOut, NOW, {
        ...DEFAULT_ATTENTION,
        unassignedHours: 8,
      }),
    ).toHaveLength(1);
  });

  it('says nothing about a job that has finished without a driver', () => {
    // Cancelled, or completed by somebody who never recorded themselves on
    // it. Either way there is nothing left to do.
    expect(
      attentionItems([job({ scheduledAt: at(-30), status: 'CANCELLED' })], NOW),
    ).toEqual([]);
    expect(
      attentionItems([job({ scheduledAt: at(-30), status: 'COMPLETED' })], NOW),
    ).toEqual([]);
  });
});

describe('assigned but not moving', () => {
  const assigned = (overrides: Partial<AttentionJob> = {}) =>
    job({ driverId: 'drv_1', status: 'ASSIGNED', ...overrides });

  it('allows a grace period past the pickup', () => {
    // Ten minutes late is a driver in traffic, not an incident.
    expect(attentionItems([assigned({ scheduledAt: at(-10) })], NOW)).toEqual([]);
  });

  it('flags a job nobody has started once the grace has gone', () => {
    const [item] = attentionItems([assigned({ scheduledAt: at(-20) })], NOW);
    expect(item).toMatchObject({ reason: 'NOT_STARTED', severity: 'warning' });
  });

  it('escalates after an hour', () => {
    const [item] = attentionItems([assigned({ scheduledAt: at(-75) })], NOW);
    expect(item).toMatchObject({ reason: 'NOT_STARTED', severity: 'critical' });
  });

  it('leaves alone a driver who is on the way', () => {
    // The case the whole module exists for. Both of these jobs read
    // `ASSIGNED`; only the one whose driver has not tapped anything needs a
    // call, and the status column cannot tell them apart.
    const chasing = assigned({ scheduledAt: at(-30) });
    const moving = {
      ...assigned({ id: 'job_2', reference: 'WL-0002', scheduledAt: at(-30) }),
      events: events(['ASSIGNED', -120], ['ON_WAY', -25]),
    };

    const items = attentionItems([chasing, moving], NOW);
    expect(items.map((item) => item.jobId)).toEqual(['job_1']);
  });

  it('counts merely accepting as not having started', () => {
    // Tapping "accepted" three hours ago and nothing since, with the pickup
    // half an hour gone, is exactly the driver worth ringing.
    const [item] = attentionItems(
      [
        {
          ...assigned({ scheduledAt: at(-30) }),
          events: events(['ASSIGNED', -180], ['ACCEPTED', -175]),
        },
      ],
      NOW,
    );
    expect(item).toMatchObject({ reason: 'NOT_STARTED' });
  });
});

describe('under way but never closed', () => {
  const running = (overrides: Partial<AttentionJob> = {}) =>
    job({ driverId: 'drv_1', status: 'IN_PROGRESS', ...overrides });

  it('is quiet while the job is still within its expected time', () => {
    // Picked up ten minutes ago on a sixty-minute job.
    const item = attentionItems(
      [{ ...running({ scheduledAt: at(-10) }), events: events(['POB', -5]) }],
      NOW,
    );
    expect(item).toEqual([]);
  });

  it('flags one that has run well past its end', () => {
    // A sixty-minute job that started two hours ago and nobody closed off.
    const [item] = attentionItems(
      [{ ...running({ scheduledAt: at(-120) }), events: events(['POB', -110]) }],
      NOW,
    );
    expect(item).toMatchObject({ reason: 'OVERRUNNING', severity: 'critical' });
    // Measured from the expected end, not the pickup: an hour overdue on a
    // sixty-minute job that started two hours ago.
    expect(item!.minutes).toBe(60);
  });

  it('uses the booked hours of an as-directed hire, not an estimate', () => {
    // A four-hour hire carries a default sixty-minute estimate, and judging it
    // against that would flag every single one three hours early.
    const hire = {
      ...running({ scheduledAt: at(-120), customerHours: 4, estimatedMinutes: 60 }),
      events: events(['POB', -115]),
    };
    expect(attentionItems([hire], NOW)).toEqual([]);
  });

  it('says nothing once the driver closes it off', () => {
    const done = {
      ...running({ scheduledAt: at(-300), status: 'COMPLETED' }),
      events: events(['POB', -290], ['COMPLETED', -240]),
    };
    expect(attentionItems([done], NOW)).toEqual([]);
  });

  it('still says nothing when the events say done but the status lags', () => {
    // The driver tapped it off in Telegram and the status write is behind.
    const done = {
      ...running({ scheduledAt: at(-300) }),
      events: events(['POB', -290], ['COMPLETED', -240]),
    };
    expect(attentionItems([done], NOW)).toEqual([]);
  });
});

describe('the list itself', () => {
  it('reports each job once, however many ways it is wrong', () => {
    // Unassigned *and* an hour past its pickup is one problem. Listed twice,
    // somebody fixes it and finds it still there.
    const items = attentionItems([job({ scheduledAt: at(-60) })], NOW);
    expect(items).toHaveLength(1);
  });

  it('puts critical before warning, and the longest-wrong first', () => {
    const items = attentionItems(
      [
        job({ id: 'soon', reference: 'WL-0003', scheduledAt: at(30) }),
        job({ id: 'old', reference: 'WL-0001', scheduledAt: at(-90) }),
        job({ id: 'recent', reference: 'WL-0002', scheduledAt: at(-5) }),
      ],
      NOW,
    );
    expect(items.map((item) => item.jobId)).toEqual(['old', 'recent', 'soon']);
  });

  it('finds nothing wrong with a covered board', () => {
    const items = attentionItems(
      [
        {
          ...job({ driverId: 'drv_1', status: 'IN_PROGRESS', scheduledAt: at(-20) }),
          events: events(['POB', -15]),
        },
        job({ id: 'later', reference: 'WL-0009', scheduledAt: at(60 * 30) }),
      ],
      NOW,
    );
    expect(items).toEqual([]);
  });
});

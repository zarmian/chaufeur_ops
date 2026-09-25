import { describe, expect, it } from 'vitest';
import {
  CHAT_CLOSED_TEXT,
  chatState,
  checkMessage,
  MESSAGE_MAX,
  type ChatJob,
} from './tracking-chat';

/**
 * Who may message a driver, and what reaches them.
 *
 * The thread is deliberately narrower than the page it sits on. The page
 * answers from the moment the link is issued; the box only opens when there is
 * a named driver, on their phone, about to do this job — because a message
 * that cannot reach anybody is worse than no box at all. A passenger who types
 * into a dead box believes they have told somebody, and stops trying.
 */

const PICKUP = new Date('2026-09-15T08:00:00Z');
/** Inside the two-hour window, before the pickup. */
const SOON = new Date('2026-09-15T07:00:00Z');

function job(over: Partial<ChatJob> = {}): ChatJob {
  return {
    status: 'ASSIGNED',
    scheduledAt: PICKUP,
    driverId: 'drv-1',
    driverReachable: true,
    ...over,
  };
}

describe('chatState', () => {
  it('opens for an assigned, reachable driver inside the window', () => {
    expect(chatState(job(), SOON)).toEqual({ open: true });
  });

  it('stays shut until two hours before the pickup', () => {
    /*
     * Held back with the driver's name, and for the same reasons: before this
     * the crew can still change, and a passenger should not be arranging a
     * kerbside meeting with somebody who may not be the one who turns up.
     */
    const night = new Date('2026-09-14T20:00:00Z');
    expect(chatState(job(), night)).toEqual({
      open: false,
      reason: 'TOO_EARLY',
    });
  });

  it('shuts the moment the journey is finished', () => {
    // The rule the whole feature turns on. The thread is about this pickup;
    // once the passenger is set down there is nothing left to arrange, and
    // leaving it open would leave a channel to a driver's phone sitting in
    // whatever chat the link was forwarded into.
    expect(chatState(job({ status: 'COMPLETED' }), SOON)).toEqual({
      open: false,
      reason: 'JOURNEY_OVER',
    });
    expect(chatState(job({ status: 'NO_SHOW' }), SOON)).toEqual({
      open: false,
      reason: 'JOURNEY_OVER',
    });
  });

  it('shuts on a cancellation, even though the page keeps answering', () => {
    /*
     * The page still says "this journey has been cancelled", which is the most
     * useful thing it ever tells anybody. The box does not stay open beside
     * it: there is no driver coming to arrange anything with, and a message
     * typed to one would go to somebody who has been stood down.
     */
    expect(chatState(job({ status: 'CANCELLED' }), SOON)).toEqual({
      open: false,
      reason: 'CANCELLED',
    });
  });

  it('shuts when nobody is on the job yet', () => {
    expect(chatState(job({ driverId: null }), SOON)).toEqual({
      open: false,
      reason: 'NO_DRIVER',
    });
  });

  it('shuts for a driver who has never linked Telegram, and says so', () => {
    /*
     * Said plainly rather than hidden. Roughly a fifth of any fleet never
     * links a bot; a passenger shown nothing assumes the feature is broken,
     * where one told the office can pass a message on rings the office — which
     * is the right outcome.
     */
    const state = chatState(job({ driverReachable: false }), SOON);

    expect(state).toEqual({ open: false, reason: 'DRIVER_UNREACHABLE' });
    expect(CHAT_CLOSED_TEXT.DRIVER_UNREACHABLE).toMatch(/office/i);
  });

  it('shuts at the backstop, when nobody ever finished the job', () => {
    // A driver who forgets to tap Completed must not leave a live channel to
    // their own phone open indefinitely.
    expect(chatState(job({ status: 'IN_PROGRESS' }), new Date('2026-09-15T21:00:00Z'))).toEqual(
      { open: false, reason: 'JOURNEY_OVER' },
    );
  });

  it('has something to say for every reason it can give', () => {
    // A closed box with no explanation is a broken box.
    for (const [reason, text] of Object.entries(CHAT_CLOSED_TEXT)) {
      expect(text.trim(), reason).not.toBe('');
    }
  });
});

describe('checkMessage', () => {
  it('takes an ordinary message', () => {
    expect(checkMessage('I am by the blue doors')).toEqual({
      ok: true,
      body: 'I am by the blue doors',
    });
  });

  it('refuses nothing at all, rather than sending a blank', () => {
    expect(checkMessage('')).toMatchObject({ ok: false });
    expect(checkMessage('   ')).toMatchObject({ ok: false });
    expect(checkMessage('\n\t ')).toMatchObject({ ok: false });
    expect(checkMessage(undefined)).toMatchObject({ ok: false });
    expect(checkMessage(42)).toMatchObject({ ok: false });
  });

  it('collapses the whitespace a phone keyboard leaves behind', () => {
    /*
     * A driver's job card is a Telegram message read at a glance, often at the
     * wheel. A message padded with forty blank lines pushes the pickup address
     * off the screen.
     */
    expect(checkMessage('  I am   by the\n\n\nblue doors  ')).toEqual({
      ok: true,
      body: 'I am by the blue doors',
    });
  });

  it('refuses one too long to be read at a glance, and says the limit', () => {
    const result = checkMessage('x'.repeat(MESSAGE_MAX + 1));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(MESSAGE_MAX));
  });

  it('takes one exactly at the limit', () => {
    expect(checkMessage('x'.repeat(MESSAGE_MAX))).toMatchObject({ ok: true });
  });

  it('says what to do about every refusal', () => {
    // A box that rejects a message without saying why is one somebody fills
    // in again identically.
    for (const bad of ['', 'x'.repeat(MESSAGE_MAX + 1)]) {
      const result = checkMessage(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.trim()).not.toBe('');
    }
  });
});

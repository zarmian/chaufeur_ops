import { describe, expect, it } from 'vitest';
import {
  routeInbound,
  smsForDriver,
  TOO_CLOSE_TO_CALL_MS,
  UNROUTABLE_NOTE,
  type InboundCandidate,
} from './tracking-chat-inbound';

/**
 * Which journey an incoming text belongs to.
 *
 * A Telegram reply carries the job in the button the driver pressed. A text
 * carries a phone number and some words, so the thread has to be inferred —
 * and the failure this file exists to prevent is one passenger reading an
 * answer meant for another.
 */

const at = (iso: string) => new Date(iso);

function candidate(over: Partial<InboundCandidate> = {}): InboundCandidate {
  return {
    jobId: 'job-1',
    reference: 'JOB-0001',
    lastAskedAt: at('2026-10-17T09:00:00Z'),
    ...over,
  };
}

describe('routeInbound', () => {
  it('places a reply on the one open thread', () => {
    expect(routeInbound([candidate()], { known: true })).toEqual({
      to: 'thread',
      jobId: 'job-1',
    });
  });

  it('sends a text from a number nobody recognises to the office', () => {
    // Not dropped. A text to the office's own gateway phone is somebody
    // trying to reach the office, even when it is nobody on the system.
    expect(routeInbound([candidate()], { known: false })).toEqual({
      to: 'ops',
      reason: 'UNKNOWN_SENDER',
    });
  });

  it('sends a driver’s text to the office when no passenger has asked anything', () => {
    /*
     * A thread nobody has written to is not a conversation, and a driver's
     * unprompted text is not a reply to one. This is what stops "running 10
     * late" appearing to a passenger who never asked — they get the proper
     * status message instead, which is what the delay flow is for.
     */
    expect(
      routeInbound([candidate({ lastAskedAt: null })], { known: true }),
    ).toEqual({ to: 'ops', reason: 'NO_OPEN_THREAD' });
  });

  it('sends it to the office when the driver has no open thread at all', () => {
    expect(routeInbound([], { known: true })).toEqual({
      to: 'ops',
      reason: 'NO_OPEN_THREAD',
    });
  });

  it('answers the passenger who asked most recently', () => {
    // A driver with two live journeys, both of whom have asked something, is
    // answering the one that just buzzed.
    const route = routeInbound(
      [
        candidate({ jobId: 'older', lastAskedAt: at('2026-10-17T08:00:00Z') }),
        candidate({ jobId: 'newer', lastAskedAt: at('2026-10-17T09:00:00Z') }),
      ],
      { known: true },
    );

    expect(route).toEqual({ to: 'thread', jobId: 'newer' });
  });

  it('refuses to guess when two passengers asked within minutes of each other', () => {
    /*
     * The branch that matters most. Recency is a guess, and it is a good one
     * across an hour and a terrible one across ninety seconds — so where it
     * would be a coin toss the text goes to the office, who can see both jobs
     * and ask. A wrong guess here shows one client another client's driver
     * talking to them.
     */
    const route = routeInbound(
      [
        candidate({ jobId: 'a', lastAskedAt: at('2026-10-17T09:00:00Z') }),
        candidate({ jobId: 'b', lastAskedAt: at('2026-10-17T09:01:00Z') }),
      ],
      { known: true },
    );

    expect(route).toEqual({ to: 'ops', reason: 'AMBIGUOUS' });
  });

  it('guesses once the gap is wide enough to mean something', () => {
    const route = routeInbound(
      [
        candidate({ jobId: 'a', lastAskedAt: at('2026-10-17T09:00:00Z') }),
        candidate({
          jobId: 'b',
          lastAskedAt: new Date(
            at('2026-10-17T09:00:00Z').getTime() + TOO_CLOSE_TO_CALL_MS + 1000,
          ),
        }),
      ],
      { known: true },
    );

    expect(route).toEqual({ to: 'thread', jobId: 'b' });
  });

  it('ignores a thread nobody asked in when choosing between several', () => {
    // One live journey with a question on it and one without: the question
    // wins, rather than the silent one being a candidate at all.
    const route = routeInbound(
      [
        candidate({ jobId: 'silent', lastAskedAt: null }),
        candidate({ jobId: 'asked', lastAskedAt: at('2026-10-17T09:00:00Z') }),
      ],
      { known: true },
    );

    expect(route).toEqual({ to: 'thread', jobId: 'asked' });
  });

  it('has something to tell the office for every way of failing', () => {
    for (const [reason, note] of Object.entries(UNROUTABLE_NOTE)) {
      expect(note.trim(), reason).not.toBe('');
    }
  });
});

describe('smsForDriver', () => {
  const text = smsForDriver({
    reference: 'JOB-0042',
    passengerMessage: 'I am by the blue doors',
    company: 'Welux',
  });

  it('carries the passenger’s words and the reference', () => {
    // The reference is for the human: a driver with two jobs on needs to know
    // which passenger is asking.
    expect(text).toContain('I am by the blue doors');
    expect(text).toContain('JOB-0042');
  });

  it('says plainly that a reply is seen by the passenger', () => {
    /*
     * The one line this message cannot do without. On Telegram the driver
     * taps Reply and knows where it goes; a text has no such gate, so
     * everything they send back lands on the passenger's page. A driver who
     * does not know that is one sentence away from telling a client something
     * meant for the office.
     */
    expect(text).toMatch(/reply to this text/i);
    expect(text).toMatch(/they will see it/i);
  });

  it('fits a couple of SMS segments rather than a dozen', () => {
    // Billed per segment, and read at a kerb. The passenger's own words are
    // the part that matters; the wrapper has to stay out of the way.
    const wrapper = text.replace('I am by the blue doors', '');
    expect(wrapper.length).toBeLessThan(160);
  });
});

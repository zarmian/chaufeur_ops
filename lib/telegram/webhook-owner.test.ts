import { describe, expect, it } from 'vitest';
import { webhookOwnership } from './webhook-owner';

/**
 * The check that stops one company's drivers reporting into another's
 * database.
 *
 * Worth testing exhaustively for the usual reason: it is the only thing
 * asking the question, the failure it prevents is silent, and the wrong
 * answer in one direction — calling somebody else's webhook ours — is worse
 * than no check at all.
 */

const OURS = 'https://acme-ops.example.com';
const HOOK = `${OURS}/api/telegram/webhook`;

describe('whose webhook is this', () => {
  it('recognises this install', () => {
    expect(webhookOwnership(HOOK, OURS)).toEqual({ state: 'ours' });
  });

  it('does not mind a trailing slash on the configured URL', () => {
    expect(webhookOwnership(HOOK, `${OURS}/`)).toEqual({ state: 'ours' });
  });

  it('ignores the case of the hostname', () => {
    // Hostnames are case-insensitive, and an install that disowned its own
    // webhook over capitalisation would send somebody hunting a fault that
    // does not exist.
    expect(webhookOwnership(HOOK, 'https://ACME-Ops.Example.com')).toEqual({
      state: 'ours',
    });
  });

  it('recognises it whatever path it was registered on', () => {
    expect(webhookOwnership(`${OURS}/some/other/path`, OURS)).toEqual({
      state: 'ours',
    });
  });

  it('spots a webhook pointed at another install', () => {
    // The case the whole check exists for.
    const other = 'https://beta-ops.example.com/api/telegram/webhook';
    expect(webhookOwnership(other, OURS)).toEqual({
      state: 'elsewhere',
      registered: other,
    });
  });

  it('is not fooled by a hostname that merely starts the same way', () => {
    /*
     * The trap a `startsWith` walks into. `acme-ops.example.com.evil.test`
     * begins with the whole of our origin and is a completely different
     * host — and this is the one direction where a wrong answer is worse
     * than no answer, because it reports "all clear".
     */
    const lookalike = 'https://acme-ops.example.com.evil.test/api/telegram/webhook';
    expect(webhookOwnership(lookalike, OURS)).toEqual({
      state: 'elsewhere',
      registered: lookalike,
    });
  });

  it('treats a different port as a different install', () => {
    expect(webhookOwnership('https://acme-ops.example.com:8443/hook', OURS)).toMatchObject({
      state: 'elsewhere',
    });
  });

  it('treats a different scheme as a different install', () => {
    expect(webhookOwnership('http://acme-ops.example.com/hook', OURS)).toMatchObject({
      state: 'elsewhere',
    });
  });

  it('reports no webhook rather than guessing', () => {
    // What a freshly created bot looks like: Telegram returns an empty
    // string, not a missing field.
    expect(webhookOwnership('', OURS)).toEqual({ state: 'none' });
    expect(webhookOwnership(null, OURS)).toEqual({ state: 'none' });
    expect(webhookOwnership('   ', OURS)).toEqual({ state: 'none' });
  });

  it('says it cannot tell when there is nothing to compare against', () => {
    // Better than a confident answer from half the information.
    expect(webhookOwnership(HOOK, null)).toMatchObject({ state: 'unknown' });
    expect(webhookOwnership(HOOK, '')).toMatchObject({ state: 'unknown' });
    expect(webhookOwnership(HOOK, 'not a url')).toMatchObject({ state: 'unknown' });
  });

  it('treats an unparseable registration as somebody else’s', () => {
    // It is certainly not ours, and "unknown" would let it pass quietly.
    expect(webhookOwnership('%%%not-a-url%%%', OURS)).toMatchObject({
      state: 'elsewhere',
    });
  });
});

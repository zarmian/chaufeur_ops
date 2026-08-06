import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from './observability';

/**
 * Error capture — spec 6.7.6.
 *
 * The behaviours worth pinning down are the ones that would be discovered
 * during an incident, which is the worst time to discover them: that capture
 * never throws, that a missing DSN degrades to a log rather than a crash,
 * and that the payload carries the user's id but not their email.
 */

const DSN = 'https://abc123@o1.ingest.sentry.io/456';

describe('captureError', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
  });

  it('logs and sends nothing when no tracker is configured', async () => {
    delete process.env.SENTRY_DSN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await captureError(new Error('boom'), { where: 'GET /api/jobs' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('puts the message and the place in the log line', async () => {
    delete process.env.SENTRY_DSN;

    await captureError(new Error('boom'), {
      where: 'GET /api/jobs',
      userId: 'user_1',
      userRole: 'OPS',
    });

    const line = vi.mocked(console.error).mock.calls[0]![0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.message).toBe('boom');
    expect(parsed.where).toBe('GET /api/jobs');
    expect(parsed.userId).toBe('user_1');
    expect(parsed.userRole).toBe('OPS');
  });

  it('sends the id and the role, and never the email', async () => {
    // An error tracker is a third-party system. Who hit this is what makes a
    // stack trace reproducible; their address is not.
    process.env.SENTRY_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'));

    await captureError(new Error('boom'), {
      where: 'GET /api/jobs',
      userId: 'user_1',
      userRole: 'ACCOUNTS',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://o1.ingest.sentry.io/api/456/envelope/');

    const body = String((init as RequestInit).body);
    expect(body).toContain('"id":"user_1"');
    expect(body).toContain('ACCOUNTS');
    expect(body).not.toMatch(/@example\.com|email/i);
  });

  it('does not throw when the tracker is unreachable', async () => {
    // An error while reporting an error must not replace the error.
    process.env.SENTRY_DSN = DSN;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(
      captureError(new Error('boom'), { where: 'GET /api/jobs' }),
    ).resolves.toBeUndefined();
  });

  it('does not throw on a malformed DSN', async () => {
    // A typo in an environment variable should cost the reporting, not the
    // request.
    process.env.SENTRY_DSN = 'not-a-dsn';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      captureError(new Error('boom'), { where: 'GET /api/jobs' }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles something thrown that was not an Error', async () => {
    delete process.env.SENTRY_DSN;

    await captureError('just a string', { where: 'cron' });

    const line = vi.mocked(console.error).mock.calls[0]![0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.type).toBe('UnknownError');
    expect(parsed.message).toBe('just a string');
  });
});

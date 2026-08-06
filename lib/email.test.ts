import { describe, expect, it, vi } from 'vitest';
import {
  emailConfigured,
  fromHeader,
  isEmailAddress,
  sendEmail,
  testEmailConnection,
  type EmailConfig,
} from './email';

/**
 * The email transport.
 *
 * Every provider call is driven through an injected `fetch`, so what is
 * asserted is the request that would actually go out — the body shape, the
 * auth header, and the base64 attachment. A test that mocked the module
 * instead would prove only that the mock was called.
 *
 * The refusals matter as much as the sends. An unconfigured mailbox must
 * come back as a value the caller can show, never as an exception that takes
 * an invoice down with it.
 */

const resend: EmailConfig = {
  provider: 'resend',
  apiKey: 're_test_key',
  fromAddress: 'billing@example.com',
  fromName: 'Accounts',
  replyTo: null,
};

const postmark: EmailConfig = {
  ...resend,
  provider: 'postmark',
  apiKey: 'pm_test_token',
  fromName: null,
};

function ok(body: unknown = {}): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function failing(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('emailConfigured', () => {
  it('needs a provider, a key and a from address', () => {
    expect(emailConfigured(resend)).toBe(true);
    expect(emailConfigured({ ...resend, provider: 'none' })).toBe(false);
    expect(emailConfigured({ ...resend, apiKey: null })).toBe(false);
    expect(emailConfigured({ ...resend, fromAddress: '' })).toBe(false);
  });
});

describe('fromHeader', () => {
  it('uses the name when there is one', () => {
    expect(fromHeader(resend)).toBe('Accounts <billing@example.com>');
    expect(fromHeader({ ...resend, fromName: null })).toBe('billing@example.com');
  });
});

describe('sendEmail', () => {
  it('posts to Resend with the attachment base64-encoded', async () => {
    const fetchImpl = ok({ id: 'msg_1' });

    const result = await sendEmail(
      resend,
      {
        to: 'client@example.com',
        subject: 'Invoice INV-2026-0001',
        html: '<p>Attached</p>',
        attachments: [
          {
            filename: 'INV-2026-0001.pdf',
            content: Buffer.from('%PDF-1.4'),
            contentType: 'application/pdf',
          },
        ],
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true, id: 'msg_1' });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer re_test_key',
    );

    const body = JSON.parse(String(init.body)) as {
      from: string;
      to: string[];
      attachments: Array<{ filename: string; content: string }>;
    };
    expect(body.from).toBe('Accounts <billing@example.com>');
    expect(body.to).toEqual(['client@example.com']);
    expect(body.attachments[0]?.content).toBe(
      Buffer.from('%PDF-1.4').toString('base64'),
    );
  });

  it('posts to Postmark with its own header and field names', async () => {
    const fetchImpl = ok({ MessageID: 'pm_1' });

    const result = await sendEmail(
      postmark,
      { to: 'client@example.com', subject: 'Hello', html: '<p>Hi</p>' },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true, id: 'pm_1' });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(
      (init.headers as Record<string, string>)['X-Postmark-Server-Token'],
    ).toBe('pm_test_token');

    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.To).toBe('client@example.com');
    expect(body.HtmlBody).toBe('<p>Hi</p>');
  });

  it('refuses without a provider, and never calls out', async () => {
    const fetchImpl = ok();
    const result = await sendEmail(
      { ...resend, provider: 'none' },
      { to: 'client@example.com', subject: 'x', html: 'x' },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EMAIL_NOT_CONFIGURED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a recipient that is not an address', async () => {
    const fetchImpl = ok();
    const result = await sendEmail(
      resend,
      { to: '', subject: 'x', html: 'x' },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_RECIPIENT');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports the provider’s reason rather than a bare status', async () => {
    // A rejected sender domain and an expired key look identical otherwise,
    // and the difference is the whole of the fix.
    const result = await sendEmail(
      resend,
      { to: 'client@example.com', subject: 'x', html: 'x' },
      failing(403, { message: 'The example.com domain is not verified' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SEND_REJECTED');
      expect(result.message).toContain('not verified');
    }
  });

  it('turns a network failure into a value, not an exception', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.resend.com');
    }) as unknown as typeof fetch;

    const result = await sendEmail(
      resend,
      { to: 'client@example.com', subject: 'x', html: 'x' },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SEND_FAILED');
  });
});

describe('testEmailConnection', () => {
  it('reads rather than sends, so no client receives a test', async () => {
    const fetchImpl = ok({ data: [] });
    const result = await testEmailConnection(resend, fetchImpl);

    expect(result.ok).toBe(true);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(url).toBe('https://api.resend.com/domains');
  });

  it('reports a rejected key', async () => {
    const result = await testEmailConnection(resend, failing(401, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BAD_CREDENTIALS');
  });

  it('says what is missing when nothing is configured', async () => {
    const result = await testEmailConnection({ ...resend, apiKey: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EMAIL_NOT_CONFIGURED');
  });
});

describe('isEmailAddress', () => {
  it.each(['a@b.co', 'first.last@example.co.uk'])('accepts %s', (value) => {
    expect(isEmailAddress(value)).toBe(true);
  });

  it.each(['', 'nobody', 'no@domain', '@example.com', null, undefined])(
    'rejects %s',
    (value) => {
      expect(isEmailAddress(value)).toBe(false);
    },
  );
});

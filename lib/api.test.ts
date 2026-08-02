import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  DEFAULT_PAGE_SIZE,
  ERROR_STATUS,
  isAuthorisedCronRequest,
  MAX_PAGE_SIZE,
  paginationFrom,
  zodFields,
} from './api';

describe('error codes', () => {
  it('maps to the statuses in the API contract', () => {
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.VALIDATION_FAILED).toBe(422);
    expect(ERROR_STATUS.INVALID_TRANSITION).toBe(409);
    expect(ERROR_STATUS.DOCUMENT_EXPIRED).toBe(409);
    expect(ERROR_STATUS.PRICE_REQUIRED).toBe(409);
    expect(ERROR_STATUS.INVOICE_LOCKED).toBe(409);
  });

  it('exposes the status on a thrown ApiError', () => {
    expect(new ApiError('PRICE_REQUIRED', 'no price').status).toBe(409);
  });
});

describe('zodFields', () => {
  it('produces a per-field message map', () => {
    const schema = z.object({
      email: z.string().email(),
      clientPricePence: z.number().int().positive(),
    });
    const result = schema.safeParse({ email: 'nope', clientPricePence: -1 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const fields = zodFields(result.error);
    expect(Object.keys(fields).sort()).toEqual(['clientPricePence', 'email']);
    expect(fields.email?.length).toBeGreaterThan(0);
  });
});

describe('paginationFrom', () => {
  const params = (query: string) => new URLSearchParams(query);

  it('defaults to page 1 at the default size', () => {
    expect(paginationFrom(params(''))).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });

  it('computes skip from page and size', () => {
    expect(paginationFrom(params('page=3&pageSize=20'))).toEqual({
      page: 3,
      pageSize: 20,
      skip: 40,
      take: 20,
    });
  });

  it('caps pageSize so nobody can ask for the whole table', () => {
    // The legacy Overview rendered 704 rows at once. This is why it cannot.
    const { pageSize } = paginationFrom(params('pageSize=100000'));
    expect(pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to sane values on nonsense input', () => {
    expect(paginationFrom(params('page=0&pageSize=-5')).page).toBe(1);
    expect(paginationFrom(params('page=abc')).page).toBe(1);
    expect(paginationFrom(params('pageSize=abc')).pageSize).toBe(
      DEFAULT_PAGE_SIZE,
    );
  });
});

describe('isAuthorisedCronRequest', () => {
  const withSecret = <T>(secret: string | undefined, fn: () => T): T => {
    const previous = process.env.CRON_SECRET;
    if (secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secret;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  };

  const request = (authorization?: string) =>
    new Request('https://example.test/api/cron/housekeeping', {
      headers: authorization ? { authorization } : {},
    });

  it('accepts the correct bearer token', () => {
    withSecret('s3cret', () => {
      expect(isAuthorisedCronRequest(request('Bearer s3cret'))).toBe(true);
    });
  });

  it('rejects a missing, wrong or malformed header', () => {
    withSecret('s3cret', () => {
      expect(isAuthorisedCronRequest(request())).toBe(false);
      expect(isAuthorisedCronRequest(request('Bearer wrong!'))).toBe(false);
      expect(isAuthorisedCronRequest(request('s3cret'))).toBe(false);
      expect(isAuthorisedCronRequest(request('Basic s3cret'))).toBe(false);
    });
  });

  it('rejects everything when no secret is configured', () => {
    // Fail closed: an unset CRON_SECRET must not mean "let anyone in".
    withSecret(undefined, () => {
      expect(isAuthorisedCronRequest(request('Bearer anything'))).toBe(false);
    });
  });
});

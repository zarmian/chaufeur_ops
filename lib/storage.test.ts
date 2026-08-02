import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  buildObjectKey,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
  sanitiseFileName,
  upload,
  StorageValidationError,
} from './storage';

describe('upload validation', () => {
  const bytes = (n: number) => Buffer.alloc(n, 1);

  it('rejects a type outside the allowlist before touching the network', async () => {
    await expect(
      upload(bytes(10), 'documents/driver/x/y.exe', 'application/x-msdownload'),
    ).rejects.toBeInstanceOf(StorageValidationError);
  });

  it('rejects an SVG — it can carry script', async () => {
    await expect(
      upload(bytes(10), 'documents/driver/x/y.svg', 'image/svg+xml'),
    ).rejects.toBeInstanceOf(StorageValidationError);
  });

  it('rejects anything over the size limit', async () => {
    await expect(
      upload(bytes(MAX_UPLOAD_BYTES + 1), 'k', 'application/pdf'),
    ).rejects.toBeInstanceOf(StorageValidationError);
  });

  it('rejects an empty file', async () => {
    await expect(
      upload(bytes(0), 'k', 'application/pdf'),
    ).rejects.toBeInstanceOf(StorageValidationError);
  });

  it('accepts exactly the documented types', () => {
    expect([...ALLOWED_MIME_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
  });

  it('signs URLs for fifteen minutes by default', () => {
    expect(DEFAULT_SIGNED_URL_TTL_SECONDS).toBe(900);
  });
});

describe('sanitiseFileName', () => {
  it('keeps a normal name readable', () => {
    expect(sanitiseFileName('phv-badge-2026.pdf')).toBe('phv-badge-2026.pdf');
  });

  it('strips directory traversal', () => {
    expect(sanitiseFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFileName('..\\..\\windows\\system32')).toBe('system32');
  });

  it('collapses whitespace and drops punctuation that confuses headers', () => {
    expect(sanitiseFileName('MOT certificate "final".pdf')).toBe(
      'MOT-certificate-final.pdf',
    );
  });

  it('never returns an empty string', () => {
    expect(sanitiseFileName('...')).toBe('file');
    expect(sanitiseFileName('')).toBe('file');
  });

  it('truncates a very long name', () => {
    expect(sanitiseFileName(`${'a'.repeat(500)}.pdf`).length).toBeLessThanOrEqual(
      120,
    );
  });
});

describe('buildObjectKey', () => {
  it('namespaces by entity type and id', () => {
    const key = buildObjectKey('driver', 'clx123', 'phv badge.pdf');
    expect(key).toMatch(
      /^documents\/driver\/clx123\/[0-9a-f-]{36}-phv-badge\.pdf$/,
    );
  });

  it('gives two uploads of the same file distinct keys', () => {
    const a = buildObjectKey('vehicle', 'clx9', 'mot.pdf');
    const b = buildObjectKey('vehicle', 'clx9', 'mot.pdf');
    expect(a).not.toBe(b);
  });

  it('accepts an alternative prefix for non-document assets', () => {
    expect(buildObjectKey('branding', 'logo', 'mark.png', 'assets')).toMatch(
      /^assets\/branding\/logo\//,
    );
  });
});

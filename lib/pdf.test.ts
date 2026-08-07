import { describe, expect, it, vi } from 'vitest';

/**
 * What the PDF failure tells the operator.
 *
 * There is one behaviour here worth a test and it is not the rendering: it is
 * the message. The old one said "Set CHROMIUM_EXECUTABLE_PATH" whatever had
 * gone wrong, which is right on a developer's Mac and actively misleading on
 * a deployment where the browser is present and its shared libraries are not.
 * Following it sends somebody to configure a path that was never the problem.
 */
vi.mock('@sparticuz/chromium', () => ({
  default: { args: [], executablePath: async () => '/nonexistent/chromium' },
}));

const { tryRenderPdf } = await import('./pdf');

describe('tryRenderPdf', () => {
  it('names a packaging failure as a packaging failure', async () => {
    vi.resetModules();
    const puppeteer = await import('puppeteer-core');
    vi.spyOn(puppeteer.default, 'launch').mockRejectedValue(
      new Error(
        '/tmp/chromium: error while loading shared libraries: libnss3.so: cannot open shared object file',
      ),
    );

    const result = await tryRenderPdf('<p>x</p>');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The actual cause, and where to fix it.
    expect(result.message).toMatch(/shared libraries/i);
    expect(result.message).toMatch(/serverExternalPackages|outputFileTracingIncludes/);
    // And explicitly not the old misdirection.
    expect(result.message).not.toMatch(/Set CHROMIUM_EXECUTABLE_PATH/);
  });

  it('still points a developer at a local browser when there is none', async () => {
    const puppeteer = await import('puppeteer-core');
    vi.spyOn(puppeteer.default, 'launch').mockRejectedValue(
      new Error("spawn /nonexistent/chromium ENOENT"),
    );

    const result = await tryRenderPdf('<p>x</p>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/CHROMIUM_EXECUTABLE_PATH/);
  });

  it('always says the printable version still works', async () => {
    // The degradation is the point: nobody should be blocked from sending an
    // invoice because a browser would not start.
    const puppeteer = await import('puppeteer-core');
    vi.spyOn(puppeteer.default, 'launch').mockRejectedValue(new Error('boom'));

    const result = await tryRenderPdf('<p>x</p>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/printable version/i);
  });
});

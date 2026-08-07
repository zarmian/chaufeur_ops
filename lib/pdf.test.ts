import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * The Lambda hint, which is the fix itself.
 *
 * `@sparticuz/chromium` unpacks the browser unconditionally but its shared
 * libraries only when it thinks it is on Lambda. Vercel is Lambda and says
 * nothing, so the browser arrived without `libnss3.so` and every PDF was a
 * 503. These assert the hint is set where it is needed and nowhere else — a
 * developer's machine must not be told it is Lambda, or the package unpacks
 * Amazon Linux libraries onto a laptop.
 */
describe('the Lambda runtime hint', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_JS_RUNTIME']) {
      delete process.env[key];
    }
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  /** Re-imported per test: the hint runs once, on first load. */
  async function hint() {
    vi.resetModules();
    const { __hintLambdaRuntimeForTests } = await import('./pdf');
    __hintLambdaRuntimeForTests();
  }

  it('names the runtime after the running Node version on Vercel', async () => {
    process.env.VERCEL = '1';
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBe(
      `nodejs${Number.parseInt(process.versions.node, 10)}.x`,
    );
  });

  it('applies on any other Lambda host too', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'invoices-pdf';
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toMatch(/^nodejs\d+\.x$/);
  });

  it('leaves a developer machine alone', async () => {
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeUndefined();
  });

  it('never overrides what the host already said', async () => {
    process.env.VERCEL = '1';
    process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs18.x';
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeUndefined();
  });
});

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

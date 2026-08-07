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
 * 503.
 *
 * The condition these guard is "am I about to launch the bundled Linux x64
 * browser", not "am I on Vercel". The first attempt asked the second question
 * — through `VERCEL` and `AWS_LAMBDA_FUNCTION_NAME` — and answered "no" on the
 * deployment it was written for, because whether a function sees those at
 * runtime is a project setting. Asking what is true of this process instead
 * cannot be switched off in a dashboard.
 */
describe('the Lambda runtime hint', () => {
  const saved = { ...process.env };
  const platform = process.platform;
  const arch = process.arch;
  const pretend = (p: NodeJS.Platform, a: string) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
    Object.defineProperty(process, 'arch', { value: a, configurable: true });
  };

  beforeEach(() => {
    for (const key of ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_JS_RUNTIME', 'CHROMIUM_EXECUTABLE_PATH']) {
      delete process.env[key];
    }
    pretend('linux', 'x64');
  });
  afterEach(() => {
    process.env = { ...saved };
    pretend(platform, arch);
  });

  /** Re-imported per test: the hint runs once, on first load. */
  async function hint() {
    vi.resetModules();
    const { __hintLambdaRuntimeForTests } = await import('./pdf');
    __hintLambdaRuntimeForTests();
  }

  it('applies wherever the bundled Linux x64 browser will be launched', async () => {
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toMatch(/^nodejs(18|22)\.x$/);
  });

  it('does not depend on Vercel advertising itself', async () => {
    // The whole point: no VERCEL, no AWS_LAMBDA_FUNCTION_NAME, still hinted.
    expect(process.env.VERCEL).toBeUndefined();
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeDefined();
  });

  /**
   * The regression that cost the second deploy. Vercel runs Node 24, and
   * `nodejs24.x` is not a string the package knows: it matched no Node 20
   * case, fell through to the Amazon Linux 2 archive, and handed Chromium a
   * library set it was not built against. Only `20.x` and `22.x` select
   * AL2023, so a newer runtime must still ask for one of those.
   */
  it.each([20, 22, 24, 26])('asks for Amazon Linux 2023 on Node %i', async (major) => {
    const real = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      value: `${major}.0.0`,
      configurable: true,
    });
    try {
      await hint();
      // The two dialects the package reads as AL2023.
      expect(process.env.AWS_LAMBDA_JS_RUNTIME).toMatch(/nodejs(20|22)\.x/);
    } finally {
      Object.defineProperty(process.versions, 'node', { value: real, configurable: true });
    }
  });

  it('still asks for Amazon Linux 2 on Node 18', async () => {
    const real = process.versions.node;
    Object.defineProperty(process.versions, 'node', { value: '18.20.0', configurable: true });
    try {
      await hint();
      expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBe('nodejs18.x');
    } finally {
      Object.defineProperty(process.versions, 'node', { value: real, configurable: true });
    }
  });

  it('stays out of the way when a browser is configured', async () => {
    process.env.CHROMIUM_EXECUTABLE_PATH = '/usr/bin/chromium';
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeUndefined();
  });

  it('does nothing where that binary cannot run at all', async () => {
    pretend('darwin', 'arm64');
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeUndefined();
  });

  it('never overrides what the host already said', async () => {
    process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs18.x';
    await hint();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeUndefined();
  });
});

describe('tryRenderPdf', () => {
  it('names the detection gap, and reports what it could see', async () => {
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

    // The actual cause, and where it is handled.
    expect(result.message).toMatch(/shared libraries/i);
    expect(result.message).toMatch(/AWS_LAMBDA_JS_RUNTIME|hintLambdaRuntime/);
    // The four facts that make the next one diagnosable without a debugger.
    expect(result.message).toMatch(/Observed:/);
    expect(result.message).toMatch(/LD_LIBRARY_PATH/);
    expect(result.message).toMatch(new RegExp(`${process.platform}/${process.arch}`));
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

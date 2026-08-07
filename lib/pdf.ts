import type ChromiumType from '@sparticuz/chromium';
import puppeteer, { type Browser } from 'puppeteer-core';

/**
 * Turning an HTML document into a PDF.
 *
 * `puppeteer-core` plus `@sparticuz/chromium` rather than plain `puppeteer`:
 * the full package bundles its own Chromium, which is larger on its own than
 * a Vercel function is allowed to be. `@sparticuz/chromium` is the same
 * browser, compressed and unpacked into the function's temp directory on
 * first use.
 *
 * Locally there is usually a Chrome already installed and no reason to unpack
 * anything, so `CHROMIUM_EXECUTABLE_PATH` short-circuits the whole business.
 *
 * One page per render and the browser closed in a `finally`. A headless
 * Chromium left running holds a few hundred megabytes, and on a serverless
 * host a leaked process is charged for until the container is reclaimed.
 */

export interface PdfOptions {
  /** Waits for images — the letterhead logo is fetched over the network. */
  timeoutMs?: number;
  landscape?: boolean;
}

/**
 * Tell `@sparticuz/chromium` it is on Lambda, because Vercel does not.
 *
 * The package unpacks the browser from `bin/chromium.br` and the libraries it
 * links against from `bin/al2023.tar.br`. The browser is unpacked
 * unconditionally; the libraries are unpacked, and `LD_LIBRARY_PATH` pointed
 * at them, only when it believes it is running on Lambda — which it decides
 * from `AWS_EXECUTION_ENV`, `AWS_LAMBDA_JS_RUNTIME` or `CODEBUILD_BUILD_IMAGE`.
 *
 * Vercel runs functions on Lambda and sets none of them. So `/tmp/chromium`
 * appeared, `/tmp/al2023/lib` did not, and every PDF died with
 * `error while loading shared libraries: libnss3.so`. Bundling was never the
 * problem: the archives shipped, nothing ever extracted them. It does not
 * reproduce in development either, because a developer's machine has those
 * libraries installed system-wide and the browser starts anyway.
 *
 * The runtime is named from the running Node version so the package picks the
 * right archive — `al2023.tar.br` for Node 20 and 22, `al2.tar.br` below that.
 * Set before the import, because the `LD_LIBRARY_PATH` half runs at module
 * load; setting it afterwards unpacks libraries the browser cannot find.
 */
function hintLambdaRuntime(): void {
  // Somewhere that is genuinely Lambda-like. `VERCEL` covers the deployment,
  // `AWS_LAMBDA_FUNCTION_NAME` any other Lambda host.
  const onLambda = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!onLambda) return;

  // Never override a real one. If the host sets these, it knows better than
  // this function does.
  if (process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_JS_RUNTIME) return;

  const major = Number.parseInt(process.versions.node, 10);
  process.env.AWS_LAMBDA_JS_RUNTIME = `nodejs${major}.x`;
}

/** Exposed for the test that guards where the hint applies. */
export const __hintLambdaRuntimeForTests = hintLambdaRuntime;

/**
 * The browser package, loaded only once the environment is right.
 *
 * A dynamic import rather than a static one so `hintLambdaRuntime` runs first.
 */
let chromiumPromise: Promise<typeof ChromiumType> | null = null;
function loadChromium(): Promise<typeof ChromiumType> {
  chromiumPromise ??= (async () => {
    hintLambdaRuntime();
    return (await import('@sparticuz/chromium')).default;
  })();
  return chromiumPromise;
}

export async function renderPdf(
  html: string,
  options: PdfOptions = {},
): Promise<Buffer> {
  const timeout = options.timeoutMs ?? 20_000;
  let browser: Browser | null = null;

  try {
    const chromium = await loadChromium();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await executablePath(chromium),
      headless: true,
    });

    const page = await browser.newPage();

    // `networkidle0` rather than `load`: the logo is a signed-URL redirect,
    // and printing before it settles produces an invoice with a broken image
    // where the letterhead should be.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout });

    const pdf = await page.pdf({
      format: 'a4',
      printBackground: true,
      landscape: options.landscape ?? false,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    return Buffer.from(pdf);
  } finally {
    await browser?.close();
  }
}

async function executablePath(
  chromium: typeof ChromiumType,
): Promise<string> {
  const configured = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  return chromium.executablePath();
}

/**
 * Render, or say why not.
 *
 * `@sparticuz/chromium` ships a Linux x64 binary, so a developer on a Mac has
 * no browser to launch unless they point `CHROMIUM_EXECUTABLE_PATH` at one.
 * That is a configuration gap rather than a fault, and it should read like
 * one — the printable HTML document is always available as the fallback, and
 * the message says so instead of surfacing a spawn error.
 */
export async function tryRenderPdf(
  html: string,
  options: PdfOptions = {},
): Promise<{ ok: true; pdf: Buffer } | { ok: false; message: string }> {
  try {
    return { ok: true, pdf: await renderPdf(html, options) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return {
      ok: false,
      message: `${diagnose(detail)} The printable version works and is the one to use meanwhile. (${detail.slice(0, 200)})`,
    };
  }
}

/**
 * Say what actually went wrong.
 *
 * This message used to be one line telling everybody to set
 * `CHROMIUM_EXECUTABLE_PATH`, which is right on a developer's Mac and
 * actively misleading on Vercel — where the browser is present and it is the
 * shared libraries beside it that are missing. Somebody following that advice
 * on a deployment is being sent to configure a path that is already correct.
 */
function diagnose(detail: string): string {
  if (/libnss3|shared libraries|cannot open shared object/i.test(detail)) {
    return (
      'The bundled browser started without its shared libraries. `@sparticuz/chromium` ' +
      'unpacks them from `bin/al2023.tar.br` only when it believes it is on Lambda, which ' +
      'it reads from AWS_LAMBDA_JS_RUNTIME or AWS_EXECUTION_ENV — neither of which Vercel ' +
      'sets. `hintLambdaRuntime` in lib/pdf.ts supplies it; if this is still failing, check ' +
      'that VERCEL or AWS_LAMBDA_FUNCTION_NAME is set in the function environment, and that ' +
      'the archives shipped (`serverExternalPackages` plus `outputFileTracingIncludes`).'
    );
  }

  if (/ENOENT|spawn|executablePath|no such file/i.test(detail)) {
    return (
      'No browser binary was found. `@sparticuz/chromium` ships Linux x64 only, so on macOS ' +
      'or ARM set CHROMIUM_EXECUTABLE_PATH to a local Chrome or Chromium.'
    );
  }

  return 'The PDF renderer failed.';
}

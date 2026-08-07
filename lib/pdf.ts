import chromium from '@sparticuz/chromium';
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

export async function renderPdf(
  html: string,
  options: PdfOptions = {},
): Promise<Buffer> {
  const timeout = options.timeoutMs ?? 20_000;
  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await executablePath(),
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

async function executablePath(): Promise<string> {
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
      'The bundled browser unpacked without its shared libraries, so it cannot start. ' +
      'That is a packaging problem, not a missing binary: `@sparticuz/chromium` keeps them ' +
      'in `bin/al2023.tar.br`, which reaches the deployment only if the package is listed ' +
      'in `serverExternalPackages` and its `bin/` directory in `outputFileTracingIncludes`.'
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

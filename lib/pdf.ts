import { existsSync } from 'node:fs';
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
  /**
   * A footer repeated on every page, with a page number.
   *
   * Chromium's own, rather than a `position: fixed` element in the document.
   * A fixed footer is out of flow: it paints at the foot of every page and
   * reserves no space, so body text runs underneath it. The only way to keep
   * a band of the page clear is a real page margin, which is what this sets.
   */
  footerText?: string;
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
 *
 * The condition is deliberately *not* "am I on Vercel". The first attempt at
 * this asked exactly that, via `VERCEL` and `AWS_LAMBDA_FUNCTION_NAME`, and
 * changed nothing on the deployment: whether a Vercel function sees those at
 * runtime depends on a project setting, so the check answered "no" on the one
 * host it existed for.
 *
 * What actually matters is narrower and observable from inside the process: we
 * are about to launch the browser this package unpacks, and that browser is a
 * Linux x64 build that needs the libraries in the archive beside it. Wherever
 * that is true, extracting them is right — on Lambda because nothing else
 * provides them, and on a Linux developer machine because the browser's own
 * libraries are the ones it was built against. Anywhere else — macOS, ARM, or
 * a configured `CHROMIUM_EXECUTABLE_PATH` — this binary is never launched and
 * the hint is not set.
 */
function hintLambdaRuntime(): void {
  // A configured browser is somebody else's, and needs none of this.
  if (process.env.CHROMIUM_EXECUTABLE_PATH) return;

  // The bundled binary is Linux x64 only. Elsewhere it cannot run at all, and
  // unpacking Amazon Linux libraries would achieve nothing.
  if (process.platform !== 'linux' || process.arch !== 'x64') return;

  // Never override a real one. If the host sets these, it knows better than
  // this function does.
  if (process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_JS_RUNTIME) return;

  process.env.AWS_LAMBDA_JS_RUNTIME = amazonLinuxGeneration();
}

/**
 * Which Amazon Linux generation's libraries to unpack, spelled as a runtime.
 *
 * The string is not really a Node version, whatever it looks like: the package
 * matches it against a fixed list to choose an archive. `20.x` and `22.x`
 * select `al2023.tar.br`; anything else containing `nodejs` selects
 * `al2.tar.br`. There is no entry for anything newer.
 *
 * Naming the running version therefore broke on the deployment the moment it
 * was Node 24: the hint read `nodejs24.x`, matched no Node 20 case, fell
 * through to the Amazon Linux 2 branch, and unpacked a library set the
 * browser was not built against — `/tmp/al2/lib` existed and Chromium died on
 * `libnspr4.so` instead of `libnss3.so`. A newer Node made it worse, not
 * better, which is not a way for this to fail.
 *
 * So the question asked is the one the package is really answering. Node 20
 * and above run on Amazon Linux 2023, and say so in the only dialect it reads.
 * Node 18 and below get Amazon Linux 2. Node 26 will keep working.
 */
function amazonLinuxGeneration(): string {
  const major = Number.parseInt(process.versions.node, 10);
  return major >= 20 ? 'nodejs22.x' : 'nodejs18.x';
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

/** The footer template is HTML; a trading name with an ampersand must not break it. */
function escapeForTemplate(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

    /*
     * No JavaScript. None of these documents has any.
     *
     * An invoice, a driver statement and a report are static HTML built from
     * template literals, and every value in them goes through `escapeHtml`.
     * That escaping is what stops injection today — but it is a rule a future
     * edit can break silently, and the consequence of breaking it here is not
     * a cosmetic bug: this browser runs *on the server*, inside the
     * deployment, so an injected `<script>` executes with whatever network
     * reach this function has.
     *
     * A client's name is typed by an operator. A passenger name arrives from
     * a booking. Neither should ever be able to run code, and turning the
     * engine off means neither can even if somebody forgets an `escapeHtml`.
     * It costs nothing, because there is nothing here to run.
     */
    await page.setJavaScriptEnabled(false);

    /*
     * `load`, which is the event that waits for images.
     *
     * This was `networkidle0` until Puppeteer 25 removed that option from
     * `setContent`. The reason for it still stands — the letterhead logo is a
     * signed-URL redirect, and printing before it settles produces an invoice
     * with a broken image where the branding should be — but `load` is the
     * right answer to that and always was: it fires once every subresource
     * has finished, images included. `networkidle0` additionally waited half
     * a second for the network to go quiet, which bought nothing here because
     * these documents make no requests of their own.
     */
    await page.setContent(html, { waitUntil: 'load', timeout });

    const pdf = await page.pdf({
      format: 'a4',
      printBackground: true,
      landscape: options.landscape ?? false,
      displayHeaderFooter: Boolean(options.footerText),
      headerTemplate: '<span></span>',
      footerTemplate: options.footerText
        ? `<div style="width:100%;padding:0 16mm;font-size:7.5pt;color:#777;
             font-family:ui-sans-serif,system-ui,sans-serif;display:flex;
             justify-content:space-between;">
             <span>${escapeForTemplate(options.footerText)}</span>
             <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
           </div>`
        : '<span></span>',
      /*
       * With a footer, every margin is set here and the document must not
       * declare `@page { margin }` at all.
       *
       * A CSS page margin wins over this one, silently. Setting a bottom
       * margin of zero in the stylesheet while asking for a footer band here
       * produced exactly that: the footer painted at the foot of the page and
       * body text ran through it, because no band was ever reserved.
       */
      margin: options.footerText
        ? { top: '16mm', right: '15mm', bottom: '16mm', left: '15mm' }
        : { top: '0', right: '0', bottom: '0', left: '0' },
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
/**
 * What the process could see when it failed.
 *
 * A deployment cannot be attached to a debugger, and the first fix for this
 * failed silently for want of exactly these four facts. Reporting them turns
 * the next 503 into something readable rather than another round of guessing.
 */
function observed(): string {
  let libDir = 'unknown';
  try {
    const base = (process.env.LD_LIBRARY_PATH ?? '').split(':')[0];
    libDir = base && existsSync(base) ? `${base} exists` : `${base || '(unset)'} missing`;
  } catch {
    // Reading /tmp must never be what turns a 503 into a 500.
  }
  return [
    `runtime hint=${process.env.AWS_LAMBDA_JS_RUNTIME ?? '(unset)'}`,
    `AWS_EXECUTION_ENV=${process.env.AWS_EXECUTION_ENV ?? '(unset)'}`,
    `LD_LIBRARY_PATH ${libDir}`,
    `${process.platform}/${process.arch} node ${process.versions.node}`,
  ].join(', ');
}

function diagnose(detail: string): string {
  if (/libnss3|shared libraries|cannot open shared object/i.test(detail)) {
    return (
      'The bundled browser started without its shared libraries. `@sparticuz/chromium` ' +
      'unpacks them from `bin/al2023.tar.br` only when it believes it is on Lambda, which ' +
      'it reads from AWS_LAMBDA_JS_RUNTIME or AWS_EXECUTION_ENV — neither of which Vercel ' +
      `sets. \`hintLambdaRuntime\` in lib/pdf.ts supplies it. Observed: ${observed()}.`
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

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: {
    // Type errors fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },
  /*
   * There was an `eslint: { ignoreDuringBuilds: false }` here.
   *
   * Next 16 dropped the key — `next build` no longer runs ESLint at all, so
   * there is nothing left to tell it not to skip. Nothing is lost: CI runs
   * `npm run lint` as its own step and has since the workflow was written,
   * which is where a lint failure has always actually stopped a merge.
   */
  /**
   * Packages Next must not bundle.
   *
   * `@node-rs/argon2` is a native addon. The two browser packages are here
   * for a different reason: `@sparticuz/chromium` ships its payload as
   * brotli archives in `bin/` — the browser in `chromium.br`, and the shared
   * libraries it links against in `al2023.tar.br` — which it unpacks into
   * `/tmp` at runtime. Bundled by webpack, those archives are not seen as
   * imports and do not reach the deployment.
   *
   * The result on Vercel was a half-unpacked browser: `/tmp/chromium` existed
   * and then died with `error while loading shared libraries: libnss3.so`,
   * because the binary had been traced and the libraries beside it had not.
   * Every invoice, payout and report PDF returned 503.
   */
  serverExternalPackages: [
    '@node-rs/argon2',
    '@sparticuz/chromium',
    'puppeteer-core',
  ],

  /**
   * And the archives themselves, for the three routes that render a PDF.
   *
   * `serverExternalPackages` stops the bundling; this makes the file tracer
   * carry `bin/` into each function. Both are needed — the first alone leaves
   * a `require` pointing at files that were never deployed.
   */
  outputFileTracingIncludes: {
    '/api/invoices/[id]/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/payouts/[id]/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/reports/pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
};

export default nextConfig;

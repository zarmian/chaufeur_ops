/**
 * The headers every response carries, and why each one is there.
 *
 * Pure, so the policy can be asserted in a unit test rather than only
 * observed by curling a running server. Middleware applies it.
 *
 * This system had none of these. That was not catastrophic — the escaping in
 * the document renderers is careful and the session cookie is `httpOnly` —
 * but it left one realistic attack wide open, and it is the cheapest to close.
 */

/**
 * A per-response nonce for Next's inline bootstrap scripts.
 *
 * Web crypto and `btoa` rather than `node:crypto` and `Buffer`: this runs in
 * middleware, which Vercel executes on the edge, and reaching for a Node
 * built-in there is how a change that works locally fails on deploy. Both of
 * these are standard globals in every runtime this can land in.
 *
 * The value only has to be unguessable within one response, which sixteen
 * bytes from a CSPRNG comfortably is.
 */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The content security policy.
 *
 * `strict-dynamic` with a nonce rather than a host allowlist: Next emits
 * inline bootstrap scripts and then loads its chunks from those, so an
 * allowlist would either have to permit `unsafe-inline` — which is no policy
 * at all — or break hydration. With `strict-dynamic` the nonced bootstrap is
 * trusted to load its own chunks and nothing else gets to run.
 *
 * `style-src` keeps `unsafe-inline`, which is a real and deliberate
 * concession. Tailwind is compiled to a stylesheet, but Next injects inline
 * styles during hydration and several components set `style` attributes for
 * values that are genuinely dynamic — the name board's font scaling, the
 * dispatch timeline's positions. Nonced styles would mean threading the nonce
 * through every one of them. Injected CSS is a far smaller prize than
 * injected script, so this is the trade taken deliberately rather than by
 * omission.
 *
 * `unsafe-eval` in development only: the dev server's fast refresh needs it,
 * and production must never have it.
 */
export function contentSecurityPolicy(
  nonce: string,
  { development = false }: { development?: boolean } = {},
): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    // Blob storage hands back signed URLs on its own host, and the branding
    // route redirects to one. `data:` covers the logo when it is inlined into
    // a PDF template.
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    // Nothing here talks to a third-party API from the browser. Telegram,
    // the payment gateways and the email provider are all called server-side.
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    // The modern half of the clickjacking defence. `X-Frame-Options` below is
    // the half that older browsers understand.
    `frame-ancestors 'none'`,
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/**
 * Everything that does not vary per request.
 *
 * `X-Frame-Options` alongside `frame-ancestors` on purpose: they say the same
 * thing to different generations of browser, and the one that matters here is
 * whichever the operator happens to be running.
 */
export function staticSecurityHeaders({
  development = false,
}: { development?: boolean } = {}): Record<string, string> {
  return {
    /*
     * The finding this file exists for.
     *
     * Every destructive action in this system — resetting the install,
     * deleting a record, marking an invoice paid — is a form post behind a
     * session cookie. Framed invisibly under a page the operator does want to
     * click, that is one click away from happening, and nothing anywhere
     * would record it as anything but the operator's own doing.
     */
    'X-Frame-Options': 'DENY',

    // Blob downloads and the CSV/XLSX exports are served with a content type;
    // a browser that sniffs past it can be talked into rendering one as HTML.
    'X-Content-Type-Options': 'nosniff',

    /*
     * Paths in this application carry record identifiers — a job reference, a
     * driver id, a name-board token. Sending those to whatever a passenger's
     * notes happened to link to is a leak with no upside, and the board token
     * in particular is a credential.
     */
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Nothing here needs any of them, and a compromised script should not be
    // able to reach for them either.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',

    // A year, subdomains included. Omitted in development, where the whole
    // point is that it is not HTTPS — a stray HSTS entry for localhost is
    // remarkably annoying to clear.
    ...(development
      ? {}
      : { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
  };
}

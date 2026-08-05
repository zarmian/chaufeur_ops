import { z } from 'zod';
import { normaliseHex } from './colour';

/**
 * Company identity, as configuration.
 *
 * Nothing in this codebase names a specific customer; CI greps for it. Every
 * field here has a working default so a fresh install runs, and looks
 * deliberate rather than unfinished, before anyone opens Settings.
 *
 * This module holds the shape, the defaults and the validation only — it
 * imports nothing that reaches Postgres, so a Client Component may read the
 * types and the schema. The database read lives in `lib/branding-store.ts`.
 */

export interface Branding {
  tradingName: string;
  legalName: string | null;

  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;

  /** Hex, e.g. `#1f6feb`. Null falls back to the neutral theme. */
  primaryColour: string | null;
  accentColour: string | null;

  addressLines: string | null;
  phone: string | null;
  supportEmail: string | null;
  websiteUrl: string | null;

  taxNumber: string | null;
  companyNumber: string | null;
  bankDetails: string | null;

  /** Job reference prefix — `ACME` produces `ACME-000767`. */
  jobReferencePrefix: string;
  /** Invoice number prefix — `INV` produces `INV-2026-0001`. */
  invoiceNumberPrefix: string;
}

export const DEFAULT_BRANDING: Branding = {
  tradingName: 'Operations',
  legalName: null,
  logoLightUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  primaryColour: null,
  accentColour: null,
  addressLines: null,
  phone: null,
  supportEmail: null,
  websiteUrl: null,
  taxNumber: null,
  companyNumber: null,
  bankDetails: null,
  jobReferencePrefix: 'JOB',
  invoiceNumberPrefix: 'INV',
};

/**
 * A reference prefix reaches a regular expression, a SQL `LIKE` and printed
 * paperwork, so it is kept to characters that mean the same thing in all
 * three. Upper-cased on the way in, because `wlx-000767` on an invoice looks
 * like a mistake.
 */
const referencePrefix = (label: string) =>
  z
    .string()
    .trim()
    .min(2, `The ${label} prefix needs at least two characters`)
    .max(8, `The ${label} prefix is limited to eight characters`)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, {
      message: `Letters and digits only, starting with a letter — the ${label} prefix is printed on paperwork`,
    })
    .transform((value) => value.toUpperCase());

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(''));

const optionalColour = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))
  .superRefine((value, ctx) => {
    if (!value) return;
    if (normaliseHex(value) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a hex colour like #1f6feb',
      });
    }
  });

/**
 * An externally hosted logo.
 *
 * `http` is refused rather than merely discouraged: the application is served
 * over TLS, and a plain-http image on an https page is blocked by the browser
 * as mixed content — so it would appear to save and then simply not show,
 * which is the worst of both.
 */
export const assetUrlField = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))
  .superRefine((value, ctx) => {
    if (!value) return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a full address, starting https://',
      });
      return;
    }
    if (url.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'The address must start https:// — a plain http image is blocked by the browser on a secure page, so it would save and then not appear.',
      });
    }
  });

export const brandingSchema = z.object({
  tradingName: z
    .string()
    .trim()
    .min(1, 'Enter the trading name')
    .max(120),
  legalName: optionalText(160),
  primaryColour: optionalColour,
  accentColour: optionalColour,
  addressLines: optionalText(400),
  phone: optionalText(40),
  supportEmail: z
    .string()
    .trim()
    .email('Enter a valid email address')
    .max(160)
    .optional()
    .or(z.literal('')),
  websiteUrl: optionalText(200),
  taxNumber: optionalText(40),
  companyNumber: optionalText(40),
  bankDetails: optionalText(600),
  jobReferencePrefix: referencePrefix('job reference'),
  invoiceNumberPrefix: referencePrefix('invoice number'),

  // Typed rather than uploaded. Empty leaves whatever is already stored
  // alone, so saving the rest of the page does not clear an uploaded logo.
  logoLightLink: assetUrlField,
  logoDarkLink: assetUrlField,
  faviconLink: assetUrlField,
});

export type BrandingInput = z.infer<typeof brandingSchema>;

/**
 * Whether a stored asset value is a link to somewhere else.
 *
 * The logo fields hold one of two things: a Blob storage key, written when a
 * file is uploaded, or an ordinary URL, typed in by someone whose logo is
 * already on their own website. The second exists because file storage is
 * optional — a deployment without a Blob store had no way to set a logo at
 * all, which made the whole white-label promise conditional on a piece of
 * infrastructure that has nothing to do with branding.
 *
 * A key never starts with a scheme, so the two cannot be confused.
 */
export function isExternalAssetUrl(value: string | null): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Where to load a branding asset from.
 *
 * An external URL is used as-is. A storage key goes through this
 * application's own route, so the signed URL never appears in the markup
 * where it would go stale in a cached page.
 */
export function brandAssetSrc(
  field: 'logoLightUrl' | 'logoDarkUrl' | 'faviconUrl',
  value: string | null,
): string | null {
  if (!value) return null;
  return isExternalAssetUrl(value)
    ? value
    : `/api/branding/asset?field=${field}`;
}


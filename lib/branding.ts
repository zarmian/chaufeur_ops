/**
 * Company identity, as configuration.
 *
 * Phase 0 returns neutral defaults. Phase 3 reads these from `Setting` and
 * caches them — the signature stays the same so no caller changes.
 *
 * Nothing here, and nothing anywhere else in the codebase, names a specific
 * customer. CI greps for it.
 */

export interface Branding {
  tradingName: string;
  legalName: string | null;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  /** Job reference prefix, e.g. `WLX` produces `WLX-000767`. */
  jobReferencePrefix: string;
  /** Invoice number prefix, e.g. `INV` produces `INV-2026-0001`. */
  invoiceNumberPrefix: string;
  supportEmail: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  tradingName: 'Operations',
  legalName: null,
  logoLightUrl: null,
  logoDarkUrl: null,
  jobReferencePrefix: 'JOB',
  invoiceNumberPrefix: 'INV',
  supportEmail: null,
};

export async function getBranding(): Promise<Branding> {
  // Phase 3 replaces this with a cached read from `Setting`.
  return DEFAULT_BRANDING;
}

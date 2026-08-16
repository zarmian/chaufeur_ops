import { cache } from 'react';
import { withAudit, type AuditContext } from './audit';
import {
  DEFAULT_BRANDING,
  type Branding,
  type BrandingInput,
} from './branding';
import { normaliseHex } from './colour';
import { prisma } from './prisma';
import { emptyToNull } from './text';

/**
 * Branding, read from and written to `Setting`.
 *
 * Kept apart from `lib/branding.ts` because that module is reached from
 * Client Components and this one reaches Postgres. Importing Prisma into a
 * client bundle throws during hydration in a way that is very hard to read
 * backwards from — `lib/client-bundle.test.ts` guards the boundary.
 *
 * Reads are memoised per request with React's `cache`, so a page that renders
 * the logo, the page title and a job reference makes one query rather than
 * three. Saving revalidates by starting a new request, which is what the
 * "takes effect immediately, no redeploy" requirement actually needs.
 */

const KEYS: Record<keyof Branding, string> = {
  tradingName: 'branding.tradingName',
  legalName: 'branding.legalName',
  logoLightUrl: 'branding.logoLightUrl',
  logoDarkUrl: 'branding.logoDarkUrl',
  faviconUrl: 'branding.faviconUrl',
  primaryColour: 'branding.primaryColour',
  accentColour: 'branding.accentColour',
  addressLines: 'branding.addressLines',
  phone: 'branding.phone',
  supportEmail: 'branding.supportEmail',
  websiteUrl: 'branding.websiteUrl',
  taxNumber: 'branding.taxNumber',
  companyNumber: 'branding.companyNumber',
  bankDetails: 'branding.bankDetails',
  invoiceSignatory: 'branding.invoiceSignatory',
  jobReferencePrefix: 'branding.jobReferencePrefix',
  invoiceNumberPrefix: 'branding.invoiceNumberPrefix',
};

/** A stored value that is not a usable string is treated as unset. */
function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asColour(value: unknown): string | null {
  const text = asText(value);
  return text ? normaliseHex(text) : null;
}

/**
 * The mapping from stored rows to `Branding`, in one place.
 *
 * Both the cached read and the uncached one used around a write go through
 * it, so there is no chance of the two drifting into disagreeing about what a
 * setting means.
 */
async function readBranding(): Promise<Branding> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.values(KEYS) } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const read = (field: keyof Branding) => byKey.get(KEYS[field]);

  return {
    tradingName: asText(read('tradingName')) ?? DEFAULT_BRANDING.tradingName,
    legalName: asText(read('legalName')),
    logoLightUrl: asText(read('logoLightUrl')),
    logoDarkUrl: asText(read('logoDarkUrl')),
    faviconUrl: asText(read('faviconUrl')),
    // A malformed colour falls back to the neutral theme rather than reaching
    // the stylesheet, where it would break every token at once.
    primaryColour: asColour(read('primaryColour')),
    accentColour: asColour(read('accentColour')),
    addressLines: asText(read('addressLines')),
    phone: asText(read('phone')),
    supportEmail: asText(read('supportEmail')),
    websiteUrl: asText(read('websiteUrl')),
    taxNumber: asText(read('taxNumber')),
    companyNumber: asText(read('companyNumber')),
    bankDetails: asText(read('bankDetails')),
    invoiceSignatory: asText(read('invoiceSignatory')),
    jobReferencePrefix:
      asText(read('jobReferencePrefix')) ?? DEFAULT_BRANDING.jobReferencePrefix,
    invoiceNumberPrefix:
      asText(read('invoiceNumberPrefix')) ??
      DEFAULT_BRANDING.invoiceNumberPrefix,
  };
}

/**
 * Branding for this request.
 *
 * Memoised, so a page rendering the logo, the page title and a job reference
 * makes one query rather than three.
 */
export const getBranding = cache(async (): Promise<Branding> => {
  try {
    return await readBranding();
  } catch {
    // Before migrations run, or if the database blinks, neutral defaults beat
    // an error page on every route in the application.
    return DEFAULT_BRANDING;
  }
});

async function writeSettings(
  values: Partial<Record<keyof Branding, string | null>>,
): Promise<void> {
  const entries = Object.entries(values) as Array<
    [keyof Branding, string | null]
  >;

  await prisma.$transaction(
    entries.map(([field, value]) =>
      value === null
        ? // Deleted rather than stored as null, so "unset" has one
          // representation and the read path has one thing to handle.
          prisma.setting.deleteMany({ where: { key: KEYS[field] } })
        : prisma.setting.upsert({
            where: { key: KEYS[field] },
            update: { value },
            create: { key: KEYS[field], value },
          }),
    ),
  );
}

export async function saveBranding(
  input: BrandingInput,
  context: AuditContext,
): Promise<void> {
  const before = await readBranding();

  await withAudit(
    'Setting',
    'update',
    async () => {
      await writeSettings({
        tradingName: input.tradingName,
        legalName: emptyToNull(input.legalName),
        primaryColour: input.primaryColour
          ? normaliseHex(input.primaryColour)
          : null,
        accentColour: input.accentColour
          ? normaliseHex(input.accentColour)
          : null,
        addressLines: emptyToNull(input.addressLines),
        phone: emptyToNull(input.phone),
        supportEmail: emptyToNull(input.supportEmail),
        websiteUrl: emptyToNull(input.websiteUrl),
        taxNumber: emptyToNull(input.taxNumber),
        companyNumber: emptyToNull(input.companyNumber),
        bankDetails: emptyToNull(input.bankDetails),
        invoiceSignatory: emptyToNull(input.invoiceSignatory),
        jobReferencePrefix: input.jobReferencePrefix,
        invoiceNumberPrefix: input.invoiceNumberPrefix,
      });

      const after = await readBranding();
      return { entityId: 'branding', before, after, result: null };
    },
    context,
  );
}

/** Store an uploaded asset's URL, or clear it. */
export async function saveBrandingAsset(
  field: 'logoLightUrl' | 'logoDarkUrl' | 'faviconUrl',
  url: string | null,
  context: AuditContext,
): Promise<void> {
  const before = await readBranding();
  await withAudit(
    'Setting',
    'update',
    async () => {
      await writeSettings({ [field]: url });
      const after = await readBranding();
      return { entityId: 'branding', before, after, result: null };
    },
    context,
  );
}

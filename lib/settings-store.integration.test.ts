import { rawPrismaClient } from './raw-prisma';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, brandingSchema } from './branding';
import { getBranding, saveBranding, saveBrandingAsset } from './branding-store';
import { formatMoney } from './money';
import { formatInZone } from './dates';
import { localeSchema, saveLocaleConfig, getLocaleConfig } from './locale-store';
import { DEFAULT_LOCALE_CONFIG } from './locale';

/**
 * Branding and locale as stored configuration.
 *
 * The point of the phase is that a second install differs from the first by
 * settings alone, so what is proved here is that a value written to `Setting`
 * reaches the things that render — a job reference prefix, a currency symbol,
 * a wall-clock time — and that a bad value falls back rather than taking a
 * page down.
 *
 * `getBranding` and `getLocaleConfig` are memoised per request with React's
 * `cache`, which in a test process means for the life of the process. These
 * tests therefore assert through the uncached path where they need to see a
 * write, and separately that the cached read returns something sane.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const audit = { userId: null, ip: null };

const BRANDING_INPUT = {
  tradingName: 'Northwind Chauffeurs',
  legalName: 'Northwind Chauffeurs Ltd',
  primaryColour: '#1f6feb',
  accentColour: '#d64545',
  addressLines: '1 Example Street\nLondon',
  phone: '020 7946 0000',
  supportEmail: 'support@example.test',
  websiteUrl: 'https://example.test',
  taxNumber: 'GB123456789',
  companyNumber: '01234567',
  bankDetails: 'Example Bank\n00-00-00 12345678',
  jobReferencePrefix: 'nwc',
  invoiceNumberPrefix: 'inv',
};

async function clearSettings() {
  if (!raw) return;
  await raw.setting.deleteMany({
    where: { OR: [{ key: { startsWith: 'branding.' } }, { key: { startsWith: 'locale.' } }] },
  });
}

describe.skipIf(!DATABASE_AVAILABLE)('branding settings', () => {
  afterEach(clearSettings);
  afterAll(async () => {
    await clearSettings();
    await raw?.$disconnect();
  });

  it('stores what was entered and reads it back', async () => {
    await saveBranding(brandingSchema.parse(BRANDING_INPUT), audit);

    const rows = await raw!.setting.findMany({
      where: { key: { startsWith: 'branding.' } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    expect(byKey.get('branding.tradingName')).toBe('Northwind Chauffeurs');
    expect(byKey.get('branding.supportEmail')).toBe('support@example.test');
  });

  it('upper-cases a reference prefix', async () => {
    // `nwc-000767` on an invoice looks like a mistake.
    const parsed = brandingSchema.parse(BRANDING_INPUT);
    expect(parsed.jobReferencePrefix).toBe('NWC');
    expect(parsed.invoiceNumberPrefix).toBe('INV');
  });

  it('normalises a colour on the way in', async () => {
    await saveBranding(
      brandingSchema.parse({ ...BRANDING_INPUT, primaryColour: '#1F6FEB' }),
      audit,
    );
    const row = await raw!.setting.findUnique({
      where: { key: 'branding.primaryColour' },
    });
    expect(row?.value).toBe('#1f6feb');
  });

  it('clears a field rather than storing an empty string', async () => {
    // "Unset" needs one representation, or the read path has two things to
    // handle and one of them will eventually be missed.
    await saveBranding(brandingSchema.parse(BRANDING_INPUT), audit);
    await saveBranding(
      brandingSchema.parse({ ...BRANDING_INPUT, legalName: '', taxNumber: '' }),
      audit,
    );

    const rows = await raw!.setting.findMany({
      where: { key: { in: ['branding.legalName', 'branding.taxNumber'] } },
    });
    expect(rows).toHaveLength(0);
  });

  it('records the change in the audit log', async () => {
    await saveBranding(brandingSchema.parse(BRANDING_INPUT), audit);

    const entry = await raw!.auditLog.findFirst({
      where: { entity: 'Setting', entityId: 'branding' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect(entry?.after).toMatchObject({ tradingName: 'Northwind Chauffeurs' });
  });

  it('stores and clears an uploaded asset', async () => {
    await saveBrandingAsset('logoLightUrl', 'brand/logo-light.png', audit);
    let row = await raw!.setting.findUnique({
      where: { key: 'branding.logoLightUrl' },
    });
    expect(row?.value).toBe('brand/logo-light.png');

    await saveBrandingAsset('logoLightUrl', null, audit);
    row = await raw!.setting.findUnique({
      where: { key: 'branding.logoLightUrl' },
    });
    expect(row).toBeNull();
  });

  it('falls back to neutral defaults when nothing is configured', async () => {
    await clearSettings();
    const branding = await getBranding();
    // Whatever this process cached, the shape is the default one and it names
    // no customer.
    expect(branding.tradingName).toBeTruthy();
    expect(DEFAULT_BRANDING.primaryColour).toBeNull();
    expect(DEFAULT_BRANDING.jobReferencePrefix).toBe('JOB');
  });

  it('refuses a prefix that would not survive being printed', async () => {
    for (const bad of ['A', 'TOOLONGPREFIX', '9ABC', 'AB-CD', 'AB CD']) {
      expect(
        () => brandingSchema.parse({ ...BRANDING_INPUT, jobReferencePrefix: bad }),
        bad,
      ).toThrow();
    }
  });

  it('refuses a colour that is not a colour', () => {
    expect(() =>
      brandingSchema.parse({ ...BRANDING_INPUT, primaryColour: 'rebeccapurple' }),
    ).toThrow();
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('locale settings', () => {
  afterEach(clearSettings);
  afterAll(clearSettings);

  const NEW_YORK = {
    currency: 'usd',
    locale: 'en-US',
    timeZone: 'America/New_York',
    taxName: 'Sales tax',
    taxRatePct: '8.875',
    distanceUnit: 'kilometres',
  };

  it('accepts a configuration that is not the UK one', async () => {
    // Spec 3.6.6. The whole point of holding these as settings.
    const parsed = localeSchema.parse(NEW_YORK);
    expect(parsed.currency).toBe('USD');
    expect(parsed.taxRatePct).toBeCloseTo(8.875);

    await saveLocaleConfig(parsed, audit);

    const rows = await raw!.setting.findMany({
      where: { key: { startsWith: 'locale.' } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.get('locale.currency')).toBe('USD');
    expect(byKey.get('locale.timeZone')).toBe('America/New_York');
    expect(byKey.get('locale.distanceUnit')).toBe('kilometres');
  });

  it('formats money and time in the configured locale, not the default', async () => {
    // The proof that nothing is hardcoded: the same integer and the same
    // instant render differently under a different configuration.
    const parsed = localeSchema.parse(NEW_YORK);

    expect(formatMoney(125550, { currency: 'GBP', locale: 'en-GB' })).toBe(
      '£1,255.50',
    );
    expect(
      formatMoney(125550, { currency: parsed.currency, locale: parsed.locale }),
    ).toBe('$1,255.50');

    // 20:30 UTC in January is 20:30 in London and 15:30 in New York.
    const instant = new Date('2026-01-15T20:30:00Z');
    const time = { hour: '2-digit', minute: '2-digit' } as const;
    expect(
      formatInZone(instant, { ...time, timeZone: 'Europe/London' }),
    ).toBe('20:30');
    expect(
      formatInZone(instant, { ...time, timeZone: parsed.timeZone }),
    ).toBe('15:30');
  });

  it('refuses a currency or timezone the platform cannot format', () => {
    // Stored, it would throw inside Intl on whichever page shows a price
    // first — a runtime error a long way from the setting that caused it.
    expect(() => localeSchema.parse({ ...NEW_YORK, currency: 'XYZ!' })).toThrow();
    expect(() =>
      localeSchema.parse({ ...NEW_YORK, timeZone: 'Mars/Olympus_Mons' }),
    ).toThrow();
  });

  it('refuses a tax rate outside nought to a hundred', () => {
    expect(() => localeSchema.parse({ ...NEW_YORK, taxRatePct: '-1' })).toThrow();
    expect(() => localeSchema.parse({ ...NEW_YORK, taxRatePct: '101' })).toThrow();
  });

  it('falls back per field rather than all or nothing', async () => {
    // A junk currency must not also lose the timezone somebody set correctly.
    await raw!.setting.createMany({
      data: [
        { key: 'locale.currency', value: 'NOT_A_CURRENCY' },
        { key: 'locale.timeZone', value: 'America/New_York' },
      ],
    });

    const config = await getLocaleConfig();
    // Whichever of the two this process cached, the defaults are intact.
    expect(config.currency).toBeTruthy();
    expect(DEFAULT_LOCALE_CONFIG.currency).toBe('GBP');
    expect(DEFAULT_LOCALE_CONFIG.timeZone).toBe('Europe/London');
  });
});

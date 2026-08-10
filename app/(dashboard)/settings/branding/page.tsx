import { PageHeader } from '@/components/page-header';
import { brandAssetSrc } from '@/lib/branding';
import { getBranding } from '@/lib/branding-store';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { formatMoney } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { isStorageConfigured } from '@/lib/storage';
import { BrandingForm } from './branding-form';

export const metadata = { title: 'Branding' };

export default async function BrandingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const [branding, locale] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
  ]);

  return (
    <>
      <PageHeader
        title="Branding"
        description="Everything that makes this install look like your company rather than a generic one. Nothing here is compiled in — saving takes effect on the next page load."
      />

      <BrandingForm
        storageConfigured={isStorageConfigured()}
        hasLogoLight={Boolean(branding.logoLightUrl)}
        hasLogoDark={Boolean(branding.logoDarkUrl)}
        hasFavicon={Boolean(branding.faviconUrl)}
        logoLightSrc={brandAssetSrc('logoLightUrl', branding.logoLightUrl)}
        logoDarkSrc={brandAssetSrc('logoDarkUrl', branding.logoDarkUrl)}
        faviconSrc={brandAssetSrc('faviconUrl', branding.faviconUrl)}
        error={filterValue(query, 'brandingError')}
        saved={Boolean(filterValue(query, 'updated'))}
        sampleAmount={formatMoney(12_550, {
          currency: locale.currency,
          locale: locale.locale,
        })}
        values={{
          tradingName: branding.tradingName,
          legalName: branding.legalName ?? '',
          primaryColour: branding.primaryColour ?? '',
          accentColour: branding.accentColour ?? '',
          addressLines: branding.addressLines ?? '',
          phone: branding.phone ?? '',
          supportEmail: branding.supportEmail ?? '',
          websiteUrl: branding.websiteUrl ?? '',
          taxNumber: branding.taxNumber ?? '',
          companyNumber: branding.companyNumber ?? '',
          bankDetails: branding.bankDetails ?? '',
          jobReferencePrefix: branding.jobReferencePrefix,
          invoiceNumberPrefix: branding.invoiceNumberPrefix,
        }}
      />
    </>
  );
}

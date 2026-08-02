import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await pageRequireCapability('manageSettings');

  return (
    <>
      <PageHeader
        title="Settings"
        description="Branding, locale, thresholds and integrations."
      />
      <PhasePlaceholder
        phase="Phase 3"
        summary="Branding and theming, company details, reference prefixes, currency, timezone and tax configuration, and the CSV import tools."
      />
    </>
  );
}

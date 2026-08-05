import { Globe, Palette, ShieldCheck, Upload } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { getBranding } from '@/lib/branding-store';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { getSettings } from '@/lib/settings';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await pageRequireCapability('manageSettings');

  const [branding, locale, settings] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
    getSettings(),
  ]);

  // Each card shows what is configured now, so the landing page answers
  // "what is this install set to" without opening four screens.
  const sections = [
    {
      href: '/settings/branding',
      icon: Palette,
      title: 'Branding',
      description: 'Company details, logos, colours and reference prefixes.',
      current: branding.tradingName,
    },
    {
      href: '/settings/locale',
      icon: Globe,
      title: 'Locale',
      description: 'Currency, language, timezone, tax and distance units.',
      current: `${locale.currency} · ${locale.timeZone}`,
    },
    {
      href: '/settings/compliance',
      icon: ShieldCheck,
      title: 'Compliance thresholds',
      description: 'How far ahead an expiring document starts warning.',
      current: `${settings.complianceWarningDays} then ${settings.complianceCriticalDays} days`,
    },
    {
      href: '/settings/import',
      icon: Upload,
      title: 'Import',
      description: 'Load drivers, vehicles and clients from a spreadsheet.',
      current: 'CSV',
    },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description="Everything that makes this install specific to your company. None of it is compiled in."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={section.href} className="block">
            <Card className="h-full transition-colors hover:bg-accent">
              <CardContent className="flex gap-4 p-5">
                <section.icon
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="font-medium">{section.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {section.description}
                  </p>
                  <p className="mt-2 truncate text-xs text-muted-foreground">
                    {section.current}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

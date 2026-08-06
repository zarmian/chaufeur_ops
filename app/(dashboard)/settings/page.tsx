import {
  CreditCard,
  Globe,
  Mail,
  MapPin,
  Send,
  Palette,
  ShieldCheck,
  Table2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { getBranding } from '@/lib/branding-store';
import { getEmailConfig } from '@/lib/email-store';
import { getAllGatewayConfigs } from '@/lib/gateways/store';
import { getPlacesConfig } from '@/lib/places/store';
import { getTelegramConfig } from '@/lib/telegram/config';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { getSettings } from '@/lib/settings';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await pageRequireCapability('manageSettings');

  const [branding, locale, settings, defaultCard] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
    getSettings(),
    prisma.rateCard.findFirst({
      where: { isDefault: true },
      select: { name: true, _count: { select: { rules: true } } },
    }),
  ]);

  const [email, gateways, places, telegram] = await Promise.all([
    getEmailConfig(),
    getAllGatewayConfigs(),
    getPlacesConfig(),
    getTelegramConfig(),
  ]);

  const emailSummary =
    email.provider === 'none'
      ? 'Not configured — invoices are sent by hand'
      : `${email.provider} · ${email.fromAddress || 'no from address'}`;

  const live = gateways.filter((gateway) => gateway.enabled);
  const gatewaySummary =
    live.length === 0
      ? 'None enabled — payments recorded by hand'
      : live.map((g) => `${g.name} (${g.environment})`).join(', ');

  const pricing = defaultCard
    ? `${defaultCard.name} · ${defaultCard._count.rules} rule${defaultCard._count.rules === 1 ? '' : 's'}`
    : 'No default rate card';

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
      href: '/settings/pricing',
      icon: Table2,
      title: 'Pricing',
      description: 'Zones, rate cards and the saved addresses that feed them.',
      current: pricing,
    },
    {
      href: '/settings/email',
      icon: Mail,
      title: 'Email',
      description: 'Where invoices are emailed from. Optional.',
      current: emailSummary,
    },
    {
      href: '/settings/gateways',
      icon: CreditCard,
      title: 'Payment gateways',
      description: 'Revolut and SumUp, for payment links and webhooks. Optional.',
      current: gatewaySummary,
    },
    {
      href: '/settings/telegram',
      icon: Send,
      title: 'Telegram',
      description:
        'The driver bot: job briefs, status taps and wait time. Optional.',
      current: telegram.enabled
        ? 'On'
        : telegram.opsTokenSet
          ? 'Configured but off'
          : 'Not configured',
    },
    {
      href: '/settings/places',
      icon: MapPin,
      title: 'Address search',
      description:
        'Where pickup and destination suggestions come from. Optional.',
      current:
        places.provider === 'google'
          ? places.keySet
            ? 'Google Places'
            : 'Google Places — no key set'
          : 'Postcode lookup — no key needed',
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

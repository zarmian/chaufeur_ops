import {
  CreditCard,
  Globe,
  Mail,
  MapPin,
  MessageSquare,
  Plane,
  Send,
  Palette,
  ShieldCheck,
  Table2,
  Upload,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getBranding } from '@/lib/branding-store';
import { getEmailConfig } from '@/lib/email-store';
import { getFlightConfig } from '@/lib/flights/store';
import { getAllGatewayConfigs } from '@/lib/gateways/store';
import { getPlacesConfig } from '@/lib/places/store';
import { getClientMessagingConfig } from '@/lib/client-messaging';
import { getTelegramConfig } from '@/lib/telegram/config';
import { getLocaleConfig } from '@/lib/locale-store';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { previewReset } from '@/lib/reset';
import { getSettings } from '@/lib/settings';

export const metadata = { title: 'Settings' };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;

  const [branding, locale, settings, defaultCard, userCount] =
    await Promise.all([
      getBranding(),
      getLocaleConfig(),
      getSettings(),
      prisma.rateCard.findFirst({
        where: { isDefault: true },
        select: { name: true, _count: { select: { rules: true } } },
      }),
      prisma.user.count({ where: { active: true } }),
    ]);

  // What a reset would remove, so the number is on the screen before anybody
  // types anything.
  const resetPreview = await previewReset();

  const [email, gateways, places, telegram, messaging, flights] =
    await Promise.all([
      getEmailConfig(),
      getAllGatewayConfigs(),
      getPlacesConfig(),
      getTelegramConfig(),
      getClientMessagingConfig(),
      getFlightConfig(),
    ]);

  const liveTemplates = Object.values(messaging.enabled).filter(Boolean).length;

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
      href: '/settings/users',
      icon: Users,
      title: 'Users',
      description: 'Who can sign in, and what each of them may do.',
      current: `${userCount} ${userCount === 1 ? 'person' : 'people'}`,
    },
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
      description:
        'Revolut and SumUp, for payment links and webhooks. Optional.',
      current: gatewaySummary,
    },
    {
      href: '/settings/flights',
      icon: Plane,
      title: 'Flight tracking',
      description:
        'Watch the flights airport jobs are meeting, and act when one moves. Optional.',
      current: !flights.enabled
        ? flights.apiKey
          ? 'Configured but off'
          : 'Not configured'
        : flights.autoAdjust
          ? 'On — moves pickups'
          : 'On — flags only',
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
      href: '/settings/messaging',
      icon: MessageSquare,
      title: 'Client messaging',
      description:
        'Booking confirmations and driver updates, by email and text. Optional.',
      current:
        liveTemplates === 0
          ? 'Nothing turned on'
          : `${liveTemplates} template${liveTemplates === 1 ? '' : 's'} on`,
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
          : 'Off — the address boxes are plain text',
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
            <Card className="hover:bg-accent h-full transition-colors">
              <CardContent className="flex gap-4 p-5">
                <section.icon
                  className="text-muted-foreground mt-0.5 size-5 shrink-0"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="font-medium">{section.title}</p>
                  <p className="text-muted-foreground mt-0.5 text-sm">
                    {section.description}
                  </p>
                  <p className="text-muted-foreground mt-2 truncate text-xs">
                    {section.current}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <DangerZone
        tradingName={branding.tradingName}
        rows={resetPreview.totalRows}
        tables={resetPreview.wipe.filter((entry) => entry.rows > 0).length}
        error={filterValue(query, 'resetError')}
        notice={filterValue(query, 'resetNotice')}
      />
    </>
  );
}

/**
 * Emptying the install, which is the one thing on this screen that cannot be
 * undone.
 *
 * Last, in its own card, in the destructive colour, behind a field that has
 * to be typed. The row count is read from the database rather than described
 * in words: "everything" is abstract, and 6,171 is not.
 */
function DangerZone({
  tradingName,
  rows,
  tables,
  error,
  notice,
}: {
  tradingName: string;
  rows: number;
  tables: number;
  error?: string | null;
  notice?: string | null;
}) {
  return (
    <Card className="border-destructive/50 mt-8">
      <CardContent className="p-5">
        <h2 className="text-destructive font-medium">Start fresh</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Empties this install of every job, client, driver, vehicle, account,
          invoice, payout and its history — {rows.toLocaleString()} rows across{' '}
          {tables} tables. Your sign-in, branding, locale, tax settings, zones
          and rate cards are kept. Deleting through the interface cannot do
          this: records are only marked deleted, and the audit log is never
          removed at all.
        </p>
        <p className="mt-2 text-sm font-medium">
          There is no undo. Take a database backup first.
        </p>

        {error ? (
          <Alert
            variant="destructive"
            className="mt-4"
            data-testid="reset-error"
          >
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert className="mt-4" data-testid="reset-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        {rows === 0 ? (
          <p className="text-muted-foreground mt-4 text-sm">
            Nothing to remove — this install is already empty.
          </p>
        ) : (
          <form
            method="post"
            action="/api/settings/reset"
            className="mt-4 flex flex-wrap items-end gap-3"
            data-testid="reset-form"
          >
            <div>
              <label
                htmlFor="confirm"
                className="mb-1 block text-sm font-medium"
              >
                Type <span translate="no">{tradingName}</span> to confirm
              </label>
              <Input
                id="confirm"
                name="confirm"
                autoComplete="off"
                spellCheck={false}
                className="max-w-xs"
                required
              />
            </div>
            <Button type="submit" variant="destructive">
              Empty this install
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

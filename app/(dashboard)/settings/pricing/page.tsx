import { AlertTriangle, Map, MapPin, Table2 } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { pageRequireCapability } from '@/lib/page-guards';
import { listRateCards, listZones } from '@/lib/pricing/config';
import { unmatchedPickups } from '@/lib/pricing/rate-card';
import { prisma } from '@/lib/prisma';

export const metadata = { title: 'Pricing' };

/**
 * The pricing configuration hub.
 *
 * Phase 4 exists to stop prices being typed twice. Everything that makes that
 * possible is here, and each card shows what is configured now — so the
 * question "why did that job price at nothing" starts from one screen rather
 * than four.
 */
export default async function PricingSettingsPage() {
  await pageRequireCapability('manageSettings');

  const [zones, cards, locations, gaps] = await Promise.all([
    listZones(),
    listRateCards(),
    prisma.location.count(),
    unmatchedPickups(200),
  ]);

  const defaultCard = cards.find((card) => card.isDefault);
  const rules = cards.reduce((total, card) => total + card._count.rules, 0);

  const sections = [
    {
      href: '/settings/pricing/rate-cards',
      icon: Table2,
      title: 'Rate cards',
      description:
        'What a journey costs, and what the driver gets for it. An account may carry its own card, overriding the default.',
      current: defaultCard
        ? `${defaultCard.name} · ${rules} rule${rules === 1 ? '' : 's'}`
        : 'No default card — nothing will price automatically',
      warn: !defaultCard,
    },
    {
      href: '/settings/pricing/zones',
      icon: Map,
      title: 'Zones',
      description:
        'Postcode prefixes that group London into the areas the rate card prices between.',
      current: `${zones.filter((zone) => zone.active).length} active`,
    },
    {
      href: '/settings/pricing/locations',
      icon: MapPin,
      title: 'Saved locations',
      description:
        'Addresses that come up on the booking form, ordered by how often they are actually used.',
      current: `${locations} saved`,
    },
    {
      href: '/settings/pricing/gaps',
      icon: AlertTriangle,
      title: 'Unpriced pickups',
      description:
        'Pickup text nothing matched. This list is the specification for improving the matcher.',
      current:
        gaps.length === 0
          ? 'Nothing outstanding'
          : `${gaps.length} address${gaps.length === 1 ? '' : 'es'} nothing priced`,
      warn: gaps.length > 0,
    },
  ];

  return (
    <>
      <PageHeader
        title="Pricing"
        description="Zones, rate cards and the addresses that feed them. A rate card never sets a price by itself — it suggests one the operator can overwrite."
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
                  <p
                    className={
                      section.warn
                        ? 'mt-2 truncate text-xs font-medium text-warning-foreground'
                        : 'mt-2 truncate text-xs text-muted-foreground'
                    }
                  >
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

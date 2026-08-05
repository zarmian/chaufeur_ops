import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { listRateCards } from '@/lib/pricing/config';

export const metadata = { title: 'Rate cards' };

/**
 * Rate card CRUD — spec 4.2.1.
 *
 * A card is a name and the dates it applies between. Dates rather than a
 * simple active flag because a fare rise on the first of the month is a
 * normal thing to plan, and the card that priced last month's jobs has to
 * stay readable afterwards.
 */
export default async function RateCardsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'cardError');
  const notice = filterValue(query, 'cardNotice');

  const cards = await listRateCards();

  return (
    <>
      <PageHeader
        title="Rate cards"
        description="What a journey costs, and what the driver gets for it. Rules are matched most-specific-first, so a Heathrow-to-Mayfair rule beats an anything-from-Heathrow one."
        actions={
          <Button asChild variant="outline">
            <Link href="/settings/pricing">
              <ArrowLeft aria-hidden />
              Pricing
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="card-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert className="mb-6" data-testid="card-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          {cards.length === 0 ? (
            <EmptyState
              title="No rate cards yet"
              description="Without one, nothing prices automatically and every fare is typed by hand — which is what this phase exists to stop."
            />
          ) : (
            cards.map((card) => (
              <Card key={card.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <Link
                        href={`/settings/pricing/rate-cards/${card.id}`}
                        className="hover:underline"
                      >
                        {card.name}
                      </Link>
                      {card.isDefault ? (
                        <Badge className="ml-2">Default</Badge>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs tabular text-muted-foreground">
                      {formatDate(card.activeFrom)} —{' '}
                      {card.activeTo ? formatDate(card.activeTo) : 'open ended'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {card._count.rules} rule
                      {card._count.rules === 1 ? '' : 's'}
                      {card._count.accounts > 0
                        ? ` · used by ${card._count.accounts} account${card._count.accounts === 1 ? '' : 's'}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/settings/pricing/rate-cards/${card.id}`}>
                        Rules
                      </Link>
                    </Button>
                    <form
                      method="post"
                      action="/api/pricing/rate-cards"
                      data-testid={`retire-${card.id}`}
                    >
                      <input type="hidden" name="intent" value="retire" />
                      <input type="hidden" name="id" value={card.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Retire
                      </Button>
                    </form>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Add a rate card</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              action="/api/pricing/rate-cards"
              className="space-y-4"
              data-testid="rate-card-form"
            >
              <input type="hidden" name="intent" value="save" />

              <div>
                <label htmlFor="name" className="mb-1 block text-sm font-medium">
                  Name
                </label>
                <Input
                  id="name"
                  name="name"
                  placeholder="Standard 2026"
                  required
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="activeFrom"
                    className="mb-1 block text-sm font-medium"
                  >
                    Applies from
                  </label>
                  <Input
                    id="activeFrom"
                    name="activeFrom"
                    type="date"
                    defaultValue={toDateOnlyString(new Date())}
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="activeTo"
                    className="mb-1 block text-sm font-medium"
                  >
                    Until
                  </label>
                  <Input id="activeTo" name="activeTo" type="date" />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Leave blank for open ended.
                  </p>
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isDefault"
                  className="mt-0.5 size-4"
                />
                <span>
                  Make this the default
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Used for every booking except those on an account with its
                    own card. Only one card is the default at a time.
                  </span>
                </span>
              </label>

              <Button type="submit">Add rate card</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

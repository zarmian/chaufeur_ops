import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { JOB_TYPES, VEHICLE_CLASSES } from '@/lib/enum-options';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { getRateCard, listZones } from '@/lib/pricing/config';

export const metadata = { title: 'Rate card' };

/**
 * Rule CRUD for one card — spec 4.2.2.
 *
 * The rules are listed in the order the matcher would consider them, most
 * specific first, because an operator seeing one price out of eleven
 * overlapping rules has no other way to tell which one produced it.
 */
export default async function RateCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const { id } = await params;
  const query = await searchParams;

  const [card, zones] = await Promise.all([getRateCard(id), listZones()]);
  if (!card) notFound();

  const error = filterValue(query, 'ruleError');
  const editing = filterValue(query, 'edit');
  const rule = card.rules.find((row) => row.id === editing) ?? null;
  const activeZones = zones.filter((zone) => zone.active || zone.id === rule?.fromZoneId || zone.id === rule?.toZoneId);

  return (
    <>
      <PageHeader
        title={card.name}
        description={`${formatDate(card.activeFrom)} — ${
          card.activeTo ? formatDate(card.activeTo) : 'open ended'
        }${card.accounts.length > 0 ? ` · used by ${card.accounts.map((a) => a.name).join(', ')}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            {card.isDefault ? <Badge>Default</Badge> : null}
            <Button asChild variant="outline">
              <Link href="/settings/pricing/rate-cards">
                <ArrowLeft aria-hidden />
                Rate cards
              </Link>
            </Button>
          </div>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="rule-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Card details</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            action="/api/pricing/rate-cards"
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="id" value={card.id} />
            <div>
              <label htmlFor="name" className="mb-1 block text-xs text-muted-foreground">
                Name
              </label>
              <Input id="name" name="name" defaultValue={card.name} required />
            </div>
            <div>
              <label
                htmlFor="activeFrom"
                className="mb-1 block text-xs text-muted-foreground"
              >
                From
              </label>
              <Input
                id="activeFrom"
                name="activeFrom"
                type="date"
                defaultValue={toDateOnlyString(card.activeFrom)}
                required
              />
            </div>
            <div>
              <label
                htmlFor="activeTo"
                className="mb-1 block text-xs text-muted-foreground"
              >
                Until
              </label>
              <Input
                id="activeTo"
                name="activeTo"
                type="date"
                defaultValue={card.activeTo ? toDateOnlyString(card.activeTo) : ''}
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                name="isDefault"
                defaultChecked={card.isDefault}
                className="size-4"
              />
              Default card
            </label>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Rules, most specific first
            </CardTitle>
          </CardHeader>
          <CardContent>
            {card.rules.length === 0 ? (
              <EmptyState
                title="No rules on this card"
                description="Until there is one, this card suggests nothing and every fare is typed by hand."
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Journey</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead className="text-right">Fare</TableHead>
                      <TableHead className="text-right">Driver</TableHead>
                      <TableHead className="text-right">Priority</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...card.rules]
                      .sort(bySpecificity)
                      .map((row) => (
                        <TableRow
                          key={row.id}
                          className={row.id === editing ? 'bg-accent' : ''}
                        >
                          <TableCell className="font-medium">
                            {row.fromZone?.name ?? 'Anywhere'} →{' '}
                            {row.toZone?.name ?? 'anywhere'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {JOB_TYPES.find((type) => type.value === row.jobType)
                              ?.label ?? row.jobType}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.vehicleClass
                              ? VEHICLE_CLASSES.find(
                                  (c) => c.value === row.vehicleClass,
                                )?.label ?? row.vehicleClass
                              : 'Any'}
                          </TableCell>
                          <TableCell className="text-right tabular">
                            {fareSummary(row)}
                          </TableCell>
                          <TableCell className="text-right tabular text-muted-foreground">
                            {driverSummary(row)}
                          </TableCell>
                          <TableCell className="text-right tabular text-muted-foreground">
                            {row.priority}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button asChild variant="ghost" size="sm">
                                <Link
                                  href={`/settings/pricing/rate-cards/${card.id}?edit=${row.id}`}
                                >
                                  Edit
                                </Link>
                              </Button>
                              <form
                                method="post"
                                action={`/api/pricing/rate-cards/${card.id}/rules`}
                              >
                                <input type="hidden" name="intent" value="delete" />
                                <input type="hidden" name="ruleId" value={row.id} />
                                <Button type="submit" variant="ghost" size="sm">
                                  Remove
                                </Button>
                              </form>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              {rule ? 'Edit rule' : 'Add a rule'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              action={`/api/pricing/rate-cards/${card.id}/rules`}
              className="space-y-4"
              data-testid="rule-form"
              key={rule?.id ?? 'new'}
            >
              <input type="hidden" name="intent" value="save" />
              {rule ? <input type="hidden" name="ruleId" value={rule.id} /> : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="jobType" label="Job type">
                  <Select
                    id="jobType"
                    name="jobType"
                    defaultValue={rule?.jobType ?? 'TRANSFER'}
                  >
                    {JOB_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="vehicleClass" label="Vehicle class">
                  <Select
                    id="vehicleClass"
                    name="vehicleClass"
                    defaultValue={rule?.vehicleClass ?? ''}
                  >
                    <option value="">Any class</option>
                    {VEHICLE_CLASSES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="fromZoneId" label="From zone">
                  <Select
                    id="fromZoneId"
                    name="fromZoneId"
                    defaultValue={rule?.fromZoneId ?? ''}
                  >
                    <option value="">Anywhere</option>
                    {activeZones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="toZoneId" label="To zone">
                  <Select
                    id="toZoneId"
                    name="toZoneId"
                    defaultValue={rule?.toZoneId ?? ''}
                  >
                    <option value="">Anywhere</option>
                    {activeZones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <p className="text-xs text-muted-foreground">
                A rule naming both zones beats one naming either, which beats
                one naming neither. The vehicle class refines within each of
                those rather than across them.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="baseFare" label="Base fare">
                  <Input
                    id="baseFare"
                    name="baseFare"
                    inputMode="decimal"
                    placeholder="0.00"
                    defaultValue={major(rule?.baseFarePence)}
                  />
                </Field>
                <Field id="perHour" label="Per hour">
                  <Input
                    id="perHour"
                    name="perHour"
                    inputMode="decimal"
                    placeholder="0.00"
                    defaultValue={major(rule?.perHourPence)}
                  />
                </Field>
                <Field id="minimumHours" label="Minimum hours">
                  <Input
                    id="minimumHours"
                    name="minimumHours"
                    inputMode="decimal"
                    placeholder="3"
                    defaultValue={rule?.minimumHours ? String(rule.minimumHours) : ''}
                  />
                </Field>
                <Field id="priority" label="Priority">
                  <Input
                    id="priority"
                    name="priority"
                    inputMode="numeric"
                    defaultValue={String(rule?.priority ?? 0)}
                  />
                </Field>
                <Field id="freeWaitMinutes" label="Free wait, minutes">
                  <Input
                    id="freeWaitMinutes"
                    name="freeWaitMinutes"
                    inputMode="numeric"
                    defaultValue={String(rule?.freeWaitMinutes ?? 15)}
                  />
                </Field>
                <Field id="waitPerMinute" label="Wait, per minute">
                  <Input
                    id="waitPerMinute"
                    name="waitPerMinute"
                    inputMode="decimal"
                    placeholder="0.00"
                    defaultValue={major(rule?.waitPerMinutePence)}
                  />
                </Field>
              </div>

              <div className="border-t pt-4">
                <p className="mb-3 text-sm font-medium">Driver pay</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field id="driverBase" label="Base">
                    <Input
                      id="driverBase"
                      name="driverBase"
                      inputMode="decimal"
                      placeholder="0.00"
                      defaultValue={major(rule?.driverBasePence)}
                    />
                  </Field>
                  <Field id="driverPerHour" label="Per hour">
                    <Input
                      id="driverPerHour"
                      name="driverPerHour"
                      inputMode="decimal"
                      placeholder="0.00"
                      defaultValue={major(rule?.driverPerHourPence)}
                    />
                  </Field>
                  <Field id="driverPctOfFare" label="% of fare">
                    <Input
                      id="driverPctOfFare"
                      name="driverPctOfFare"
                      inputMode="decimal"
                      placeholder="70"
                      defaultValue={
                        rule?.driverPctOfFare ? String(rule.driverPctOfFare) : ''
                      }
                    />
                  </Field>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  A percentage of the fare <strong>or</strong> a fixed amount,
                  never both — together they would overpay on every job, and a
                  rule setting both is refused.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button type="submit">{rule ? 'Save rule' : 'Add rule'}</Button>
                {rule ? (
                  <Button asChild variant="ghost">
                    <Link href={`/settings/pricing/rate-cards/${card.id}`}>
                      Cancel
                    </Link>
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function major(pence: number | undefined): string {
  if (!pence) return '';
  return (pence / 100).toFixed(2);
}

/** The matcher's own order, so the table reads the way pricing behaves. */
function bySpecificity(
  a: { fromZoneId: string | null; toZoneId: string | null; vehicleClass: string | null; priority: number; id: string },
  b: typeof a,
): number {
  const weight = (rule: typeof a) =>
    (rule.fromZoneId ? 4 : 0) + (rule.toZoneId ? 4 : 0) + (rule.vehicleClass ? 1 : 0);
  return (
    weight(b) - weight(a) || b.priority - a.priority || a.id.localeCompare(b.id)
  );
}

function fareSummary(rule: {
  baseFarePence: number;
  perHourPence: number;
  minimumHours: unknown;
}): string {
  const parts: string[] = [];
  if (rule.perHourPence > 0) {
    parts.push(
      `${formatGBP(rule.perHourPence)}/hr${rule.minimumHours ? ` min ${rule.minimumHours}` : ''}`,
    );
  }
  if (rule.baseFarePence > 0) parts.push(formatGBP(rule.baseFarePence));
  // A rule with neither prices every matching job at nothing, which the
  // validation refuses — but an older row could still say it, and silence
  // would be the worst way to show that.
  return parts.length > 0 ? parts.join(' + ') : 'nothing';
}

function driverSummary(rule: {
  driverPctOfFare: unknown;
  driverBasePence: number;
  driverPerHourPence: number;
}): string {
  if (rule.driverPctOfFare) return `${String(rule.driverPctOfFare)}%`;
  const parts: string[] = [];
  if (rule.driverPerHourPence > 0) parts.push(`${formatGBP(rule.driverPerHourPence)}/hr`);
  if (rule.driverBasePence > 0) parts.push(formatGBP(rule.driverBasePence));
  return parts.length > 0 ? parts.join(' + ') : '—';
}

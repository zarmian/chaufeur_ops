import { Paperclip, X } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatDate, toDateOnlyString } from '@/lib/dates';
import { formatGBP } from '@/lib/money';
import { COST_KIND_LABELS, STANDING_COST_KINDS } from '@/lib/vehicle-costs';

/**
 * What a car costs to run.
 *
 * A Server Component with plain form posts, like the job expenses panel — no
 * client state is needed and it keeps working without JavaScript.
 *
 * The two halves answer different questions and are deliberately kept apart.
 * A repair is a thing that happened on a date. A lease payment is a
 * commitment that runs, and entering twelve of them by hand is how a car
 * quietly stops looking expensive. Standing costs are recorded once and
 * accrue pro-rata into whatever window the profit view is asked about.
 */

export interface CostRow {
  id: string;
  kind: string;
  amountPence: number;
  incurredOn: Date;
  supplier: string | null;
  invoiceRef: string | null;
  odometer: number | null;
  note: string | null;
  receiptFileKey: string | null;
}

export interface StandingRow {
  id: string;
  kind: string;
  label: string;
  amountPence: number;
  periodMonths: number;
  startsOn: Date;
  endsOn: Date | null;
}

const ONE_OFF_KINDS = [
  'SERVICE',
  'REPAIR',
  'MOT_TEST',
  'TYRES',
  'BODYWORK',
  'CLEANING',
  'BREAKDOWN_COVER',
  'PARKING_PERMIT',
  'OTHER',
] as const;

function periodLabel(months: number): string {
  if (months === 1) return 'a month';
  if (months === 12) return 'a year';
  if (months === 3) return 'a quarter';
  return `${months} months`;
}

export function CostsPanel({
  vehicleId,
  costs,
  standing,
  companyOwned,
  ownerName,
  mayEdit,
  mayViewReceipts,
  storageConfigured,
  error,
  today,
}: {
  vehicleId: string;
  costs: CostRow[];
  standing: StandingRow[];
  companyOwned: boolean;
  ownerName: string | null;
  mayEdit: boolean;
  mayViewReceipts: boolean;
  storageConfigured: boolean;
  error?: string | null;
  today: string;
}) {
  const action = `/api/vehicles/${vehicleId}/costs`;

  /*
   * "Ended" is judged against the day the page was built, not against a clock
   * read while rendering.
   *
   * `today` already arrives as a prop, resolved by the server page in the
   * install's configured timezone — which is the right authority, since a
   * standing cost ends on a *date* rather than at an instant. Reading
   * `Date.now()` here instead compared each row against a slightly later
   * moment than the one before it, and did it in the browser's zone rather
   * than the operator's.
   */

  // Not a permission problem and not an error — this car's costs belong to
  // somebody else, so there is nothing to enter and saying why is more use
  // than an empty form that refuses everything.
  if (!companyOwned) {
    return (
      <div className="space-y-3" data-testid="costs-panel">
        {error ? (
          <Alert variant="destructive" data-testid="cost-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm text-muted-foreground" data-testid="costs-not-ours">
          {ownerName ? `${ownerName} owns this car` : 'This car belongs to its driver'}
          , so its repairs, servicing, insurance and tax are theirs. Recording
          them here would understate what the car earns us and overstate what
          we spend.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="costs-panel">
      {error ? (
        <Alert variant="destructive" data-testid="cost-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section>
        <h3 className="mb-2 text-sm font-medium">One-off costs</h3>
        {costs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing recorded. Services, repairs, MOTs and tyres belong here.
          </p>
        ) : (
          <ul className="divide-y" data-testid="cost-list">
            {costs.map((cost) => (
              <li key={cost.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {COST_KIND_LABELS[
                      cost.kind as keyof typeof COST_KIND_LABELS
                    ] ?? cost.kind}
                    {cost.supplier ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {cost.supplier}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="tabular">{formatDate(cost.incurredOn)}</span>
                    {cost.odometer !== null ? (
                      <span className="tabular">
                        {' · '}
                        {cost.odometer.toLocaleString()} miles
                      </span>
                    ) : null}
                    {cost.invoiceRef ? ` · ${cost.invoiceRef}` : ''}
                  </p>
                </div>
                {cost.receiptFileKey && mayViewReceipts ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      href={`/api/vehicle-costs/${cost.id}/receipt`}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Receipt for this ${(
                        COST_KIND_LABELS[
                          cost.kind as keyof typeof COST_KIND_LABELS
                        ] ?? cost.kind
                      ).toLowerCase()}`}
                      data-testid="cost-receipt"
                    >
                      <Paperclip aria-hidden />
                    </Link>
                  </Button>
                ) : null}
                <span className="tabular whitespace-nowrap text-sm">
                  {formatGBP(cost.amountPence)}
                </span>
                {mayEdit ? (
                  <form method="post" action={action}>
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="costId" value={cost.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove this cost"
                    >
                      <X aria-hidden />
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {mayEdit ? (
          <form
            method="post"
            action={action}
            // Multipart because of the receipt. Harmless for the text-only
            // case, and the route reads both the same way.
            encType="multipart/form-data"
            className="mt-4 grid gap-2 border-t pt-4 sm:grid-cols-[9rem_7rem_9rem_1fr_auto]"
            data-testid="cost-form"
          >
            <input type="hidden" name="intent" value="cost" />
            <Field id="cost-kind" label="Kind">
              <Select id="cost-kind" name="kind" defaultValue="REPAIR">
                {ONE_OFF_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {COST_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="cost-amount" label="Amount">
              <Input
                id="cost-amount"
                name="amount"
                inputMode="decimal"
                placeholder="120.00"
              />
            </Field>
            <Field id="cost-date" label="Date">
              <Input
                id="cost-date"
                name="incurredOn"
                type="date"
                defaultValue={today}
              />
            </Field>
            <Field id="cost-supplier" label="Supplier">
              <Input id="cost-supplier" name="supplier" placeholder="Garage" />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Add</Button>
            </div>
            <Field
              id="cost-odometer"
              label="Odometer"
              hint="A service also moves the last-service marks."
            >
              <Input
                id="cost-odometer"
                name="odometer"
                type="number"
                min={0}
                className="tabular"
              />
            </Field>
            <Field id="cost-invoice" label="Invoice ref">
              <Input id="cost-invoice" name="invoiceRef" />
            </Field>
            {storageConfigured ? (
              <Field
                id="cost-receipt"
                label="Receipt"
                hint="JPEG, PNG, WebP or PDF."
              >
                <Input
                  id="cost-receipt"
                  name="receipt"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs"
                />
              </Field>
            ) : (
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">
                  File storage is not configured, so receipts cannot be
                  attached. The costs themselves record fine without them.
                </p>
              </div>
            )}
            <input type="hidden" name="note" value="" />
          </form>
        ) : null}
      </section>

      <section className="border-t pt-6">
        <h3 className="text-sm font-medium">Standing costs</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          Recorded once and spread across the period they cover, so a £1,200
          annual premium shows as about £100 in a month rather than making one
          month look like a disaster and eleven look free.
        </p>

        {standing.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None set up. Finance, lease, insurance and road tax belong here.
          </p>
        ) : (
          <ul className="divide-y" data-testid="standing-list">
            {standing.map((cost) => (
              <li key={cost.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {cost.label}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {COST_KIND_LABELS[
                        cost.kind as keyof typeof COST_KIND_LABELS
                      ] ?? cost.kind}
                    </span>
                  </p>
                  <p className="tabular text-xs text-muted-foreground">
                    From {formatDate(cost.startsOn)}
                    {cost.endsOn ? ` to ${formatDate(cost.endsOn)}` : ' · ongoing'}
                  </p>
                </div>
                {cost.endsOn && toDateOnlyString(cost.endsOn) < today ? (
                  <Badge variant="secondary">Ended</Badge>
                ) : null}
                <span className="tabular whitespace-nowrap text-sm">
                  {formatGBP(cost.amountPence)}
                  <span className="text-muted-foreground">
                    {' / '}
                    {periodLabel(cost.periodMonths)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {mayEdit ? (
          <form
            method="post"
            action={action}
            className="mt-4 grid gap-2 border-t pt-4 sm:grid-cols-[9rem_1fr_7rem_7rem_auto]"
            data-testid="standing-form"
          >
            <input type="hidden" name="intent" value="standing" />
            <Field id="standing-kind" label="Kind">
              <Select id="standing-kind" name="kind" defaultValue="INSURANCE">
                {STANDING_COST_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {COST_KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="standing-label" label="Name">
              <Input
                id="standing-label"
                name="label"
                placeholder="Fleet policy"
              />
            </Field>
            <Field id="standing-amount" label="Amount">
              <Input
                id="standing-amount"
                name="amount"
                inputMode="decimal"
                placeholder="1200.00"
              />
            </Field>
            <Field id="standing-period" label="Every (months)">
              <Input
                id="standing-period"
                name="periodMonths"
                type="number"
                min={1}
                max={120}
                defaultValue={12}
                className="tabular"
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Add</Button>
            </div>
            <Field id="standing-starts" label="Starts">
              <Input
                id="standing-starts"
                name="startsOn"
                type="date"
                defaultValue={today}
              />
            </Field>
            <Field id="standing-ends" label="Ends" hint="Blank while it runs.">
              <Input id="standing-ends" name="endsOn" type="date" />
            </Field>
            <input type="hidden" name="note" value="" />
          </form>
        ) : null}
      </section>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

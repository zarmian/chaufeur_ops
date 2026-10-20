import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { FilteredSelect } from '@/components/filtered-select';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toDateOnlyString } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { VAT_TREATMENTS } from '@/lib/vat';

export const metadata = { title: 'Invoice without a job' };

/**
 * Bill something that never went through dispatch.
 *
 * A monthly management fee, a late cancellation, an agency commission, a
 * valet recharged to the client who made it necessary. Before this the only
 * way to raise an invoice was to pick billable jobs and hires, so these were
 * either not billed at all or hung off an unrelated job — which puts a charge
 * on a line describing a journey it has nothing to do with, and makes that
 * job's revenue wrong in every report afterwards.
 *
 * Deliberately a short form. It asks for the least that makes a real document
 * — who it goes to, and one thing being charged — and then hands over to the
 * invoice's own page, where the line editor that already exists adds the rest.
 * Building a second multi-line editor here would be a second thing to keep in
 * step with the first.
 *
 * A plain form post rather than a Server Action, like every other form that
 * decides money: a submission that silently does not land is not acceptable
 * when the result is a document somebody is owed against.
 */
export default async function AdHocInvoicePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('editInvoices');
  const query = await searchParams;
  const error = filterValue(query, 'error');

  const [accounts, clients, locale] = await Promise.all([
    prisma.account.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.client.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    getLocaleConfig(),
  ]);

  const taxName = locale.taxName;
  const today = toDateOnlyString(new Date());

  return (
    <>
      <PageHeader
        title="Invoice without a job"
        description="For work that never went through dispatch — a management fee, a cancellation charge, a commission."
        actions={
          <Button asChild variant="ghost">
            <Link href="/invoices">
              <ArrowLeft aria-hidden />
              Invoices
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="ad-hoc-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form
        method="post"
        action="/api/invoices/ad-hoc"
        className="max-w-2xl space-y-6"
        data-testid="ad-hoc-invoice-form"
      >
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Who it goes to
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="accountId" className="mb-1 block text-sm font-medium">
                Account
              </label>
              <FilteredSelect
                id="accountId"
                name="accountId"
                options={accounts.map((account) => ({
                  value: account.id,
                  label: account.name,
                }))}
                emptyLabel="No account"
                searchLabel="Search accounts"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                The usual biller — whoever placed the work.
              </p>
            </div>

            <div>
              <label htmlFor="clientId" className="mb-1 block text-sm font-medium">
                Or a client
              </label>
              <FilteredSelect
                id="clientId"
                name="clientId"
                options={clients.map((client) => ({
                  value: client.id,
                  label: client.name,
                }))}
                emptyLabel="No client"
                searchLabel="Search clients to bill"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                Used only when no account is chosen.
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            What is being charged
          </h2>

          <div>
            <label htmlFor="description" className="mb-1 block text-sm font-medium">
              Description
            </label>
            <Input
              id="description"
              name="description"
              required
              placeholder="Management fee — October 2026"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="amount" className="mb-1 block text-sm font-medium">
                Amount
              </label>
              <Input
                id="amount"
                name="amount"
                inputMode="decimal"
                required
                placeholder="450.00"
                className="text-right tabular"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                A negative figure is a credit.
              </p>
            </div>

            <div>
              <label htmlFor="disbursement" className="mb-1 block text-sm font-medium">
                Of which untaxed
              </label>
              <Input
                id="disbursement"
                name="disbursement"
                inputMode="decimal"
                placeholder="0.00"
                className="text-right tabular"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                Paid on their behalf — never carries {taxName}.
              </p>
            </div>

            <div>
              <label htmlFor="vatTreatment" className="mb-1 block text-sm font-medium">
                {taxName}
              </label>
              <Select id="vatTreatment" name="vatTreatment" defaultValue="STANDARD">
                {VAT_TREATMENTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            One line is enough to start. More can be added on the invoice itself,
            which opens next.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Dates and notes
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="issueDate" className="mb-1 block text-sm font-medium">
                Issue date
              </label>
              <Input id="issueDate" name="issueDate" type="date" defaultValue={today} />
            </div>

            <div>
              <label htmlFor="dueDate" className="mb-1 block text-sm font-medium">
                Due date
              </label>
              <Input id="dueDate" name="dueDate" type="date" />
              <p className="mt-1 text-sm text-muted-foreground">
                Left blank, the recipient&rsquo;s payment terms decide.
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="notes" className="mb-1 block text-sm font-medium">
              Notes on the invoice
            </label>
            <Textarea id="notes" name="notes" rows={2} />
          </div>
        </section>

        <div className="flex items-center gap-3 border-t pt-6">
          <Button type="submit">Raise the invoice</Button>
          <Button asChild variant="ghost">
            <Link href="/invoices">Cancel</Link>
          </Button>
        </div>
      </form>
    </>
  );
}

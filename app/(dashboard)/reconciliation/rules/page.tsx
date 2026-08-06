import { ArrowLeft, Plus } from 'lucide-react';
import Link from 'next/link';
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
import { can } from '@/lib/authz';
import { TXN_KINDS } from '@/lib/bank/classify';
import { listRules } from '@/lib/bank/store';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Classification rules' };

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await pageRequireCapability('viewInvoices');
  const query = await searchParams;
  const error = filterValue(query, 'ruleError');
  const editable = can(user, 'editInvoices');

  const rules = await listRules();

  return (
    <>
      <PageHeader
        title="Classification rules"
        description="A phrase and what it means, nothing cleverer. Anything unmatched stays unclassified and visible."
        actions={
          <Button asChild variant="outline">
            <Link href="/reconciliation">
              <ArrowLeft aria-hidden />
              Back
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="rule-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {editable ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add a rule</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              action="/api/reconciliation/rules"
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="intent" value="create" />
              <div className="min-w-64 flex-1">
                <label htmlFor="phrase" className="mb-1 block text-sm font-medium">
                  When the description contains
                </label>
                <Input id="phrase" name="phrase" required placeholder="shell" />
              </div>
              <div>
                <label htmlFor="kind" className="mb-1 block text-sm font-medium">
                  Treat it as
                </label>
                <Select id="kind" name="kind" defaultValue="FUEL" className="w-56">
                  {TXN_KINDS.filter((kind) => kind.value !== 'UNCLASSIFIED').map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="priority" className="mb-1 block text-sm font-medium">
                  Priority
                </label>
                <Input
                  id="priority"
                  name="priority"
                  type="number"
                  defaultValue={0}
                  className="w-24"
                />
              </div>
              <Button type="submit">
                <Plus aria-hidden />
                Add
              </Button>
            </form>
            <p className="mt-3 text-sm text-muted-foreground">
              The longest matching phrase wins, then priority. A rule is only applied in
              the direction it can make sense in — a client payment rule never matches
              money leaving the account.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {rules.length === 0 ? (
        <EmptyState
          title="No rules yet"
          description="Import a statement and the starting set is written for you — fuel and road charges, which every operator has."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phrase</TableHead>
              <TableHead>Treated as</TableHead>
              <TableHead className="text-right">Priority</TableHead>
              <TableHead className="text-right">Times matched</TableHead>
              <TableHead>State</TableHead>
              {editable ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="font-medium">{rule.phrase}</TableCell>
                <TableCell>
                  {TXN_KINDS.find((k) => k.value === rule.kind)?.label ?? rule.kind}
                </TableCell>
                <TableCell className="text-right tabular-nums">{rule.priority}</TableCell>
                <TableCell className="text-right tabular-nums">{rule.hitCount}</TableCell>
                <TableCell>
                  <Badge variant={rule.active ? 'success' : 'secondary'}>
                    {rule.active ? 'Active' : 'Off'}
                  </Badge>
                </TableCell>
                {editable ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <form method="post" action="/api/reconciliation/rules">
                        <input type="hidden" name="intent" value="toggle" />
                        <input type="hidden" name="id" value={rule.id} />
                        <input
                          type="hidden"
                          name="active"
                          value={rule.active ? 'false' : 'true'}
                        />
                        <Button type="submit" variant="outline" size="sm">
                          {rule.active ? 'Turn off' : 'Turn on'}
                        </Button>
                      </form>
                      <form method="post" action="/api/reconciliation/rules">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={rule.id} />
                        <Button type="submit" variant="outline" size="sm">
                          Delete
                        </Button>
                      </form>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

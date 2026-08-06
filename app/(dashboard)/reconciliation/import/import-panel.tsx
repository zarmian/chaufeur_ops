'use client';

import { AlertCircle, CheckCircle2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Upload, see what it would do, then do it.
 *
 * The preview is a server round trip rather than a browser parse, because the
 * two questions that matter — how many of these rows have I already imported,
 * and who do they belong to — can only be answered against the database.
 *
 * Nothing is written by the preview. The same file is posted again to import
 * it, which costs one extra upload and buys an operator the chance to notice
 * that their bank exported the wrong month.
 */

const PREVIEW_ROWS = 15;

interface PreviewRow {
  occurredOn: string;
  description: string;
  amountPence: number;
  bankRef: string | null;
}

interface PreviewResponse {
  layout: string;
  fresh: number;
  duplicates: number;
  problems: Array<{ line: number; reason: string }>;
  periodStart: string | null;
  periodEnd: string | null;
  rows: PreviewRow[];
  headers: string[];
  needsMapping: boolean;
}

export function ImportPanel({ currency, locale }: { currency: string; locale: string }) {
  const router = useRouter();
  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Column names, only asked for when nothing was recognised.
  const [mapping, setMapping] = useState({
    date: '',
    description: '',
    amount: '',
    debit: '',
    credit: '',
  });

  const money = (pence: number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(pence / 100);

  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof json.message === 'string' ? json.message : 'That could not be done',
      );
    }
    return json;
  }

  async function onFile(file: File | undefined) {
    setError(null);
    setPreview(null);
    if (!file) return;

    const text = await file.text();
    setFilename(file.name);
    setCsv(text);
    await runPreview(text);
  }

  async function runPreview(text: string, withMapping?: typeof mapping) {
    setBusy(true);
    setError(null);
    try {
      const json = (await post('/api/reconciliation/preview', {
        csv: text,
        mapping: withMapping && withMapping.date ? withMapping : undefined,
      })) as unknown as PreviewResponse;
      setPreview(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be read');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const json = await post('/api/reconciliation/import', {
        filename,
        csv,
        mapping: mapping.date ? mapping : undefined,
      });
      router.push(`/reconciliation?statementId=${String(json.statementId)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be imported');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="statement" className="mb-2 block text-sm font-medium">
          Statement CSV
        </label>
        <Input
          id="statement"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
        <p className="mt-2 text-sm text-muted-foreground">
          Barclays, HSBC, Lloyds, NatWest, Revolut Business and Starling exports are
          recognised without any setup. Anything else asks you which column is which.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {preview?.needsMapping ? (
        <div className="rounded-lg border p-4">
          <p className="mb-1 font-medium">Which column is which?</p>
          <p className="mb-4 text-sm text-muted-foreground">
            The file has these columns: {preview.headers.join(', ')}. Type the name of
            each, exactly as it appears. Leave the amount blank if your bank uses
            separate debit and credit columns.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['date', 'description', 'amount', 'debit', 'credit'] as const).map((key) => (
              <div key={key}>
                <label htmlFor={`map-${key}`} className="mb-1 block text-sm capitalize">
                  {key}
                </label>
                <Input
                  id={`map-${key}`}
                  value={mapping[key]}
                  onChange={(event) =>
                    setMapping((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <Button
            className="mt-4"
            variant="outline"
            disabled={busy || !mapping.date || !mapping.description}
            onClick={() => void runPreview(csv, mapping)}
          >
            Read it again
          </Button>
        </div>
      ) : null}

      {preview && !preview.needsMapping ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{preview.layout}</Badge>
            <Badge variant="success">{preview.fresh} to import</Badge>
            {preview.duplicates > 0 ? (
              <Badge variant="secondary">{preview.duplicates} already imported</Badge>
            ) : null}
            {preview.problems.length > 0 ? (
              <Badge variant="destructive">{preview.problems.length} unreadable</Badge>
            ) : null}
            {preview.periodStart ? (
              <span className="text-sm text-muted-foreground">
                {preview.periodStart} to {preview.periodEnd}
              </span>
            ) : null}
          </div>

          {preview.duplicates > 0 ? (
            <Alert>
              <CheckCircle2 aria-hidden />
              <AlertDescription>
                {preview.duplicates} of these have been imported before and will be
                skipped. Re-uploading an overlapping period is safe.
              </AlertDescription>
            </Alert>
          ) : null}

          {preview.problems.length > 0 ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertDescription>
                <p className="mb-1 font-medium">
                  {preview.problems.length} row
                  {preview.problems.length === 1 ? '' : 's'} could not be read, and will
                  not be imported:
                </p>
                <ul className="list-inside list-disc text-sm">
                  {preview.problems.slice(0, 5).map((problem) => (
                    <li key={problem.line}>
                      Line {problem.line}: {problem.reason}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {preview.rows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                  <TableRow key={`${row.occurredOn}-${index}`}>
                    <TableCell className="whitespace-nowrap">{row.occurredOn}</TableCell>
                    <TableCell className="max-w-[28rem] truncate">
                      {row.description}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(row.amountPence)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Button disabled={busy || preview.fresh === 0} onClick={() => void confirm()}>
            <Upload aria-hidden />
            {preview.fresh === 0
              ? 'Nothing new to import'
              : `Import ${preview.fresh} transaction${preview.fresh === 1 ? '' : 's'}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

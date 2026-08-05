'use client';

import { AlertCircle, CheckCircle2, Download, Upload } from 'lucide-react';
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
import { CsvError, parseCsv } from '@/lib/csv';
import {
  findDuplicatesInFile,
  validateClientRow,
  validateDriverRow,
  validateVehicleRow,
  type RowError,
} from '@/lib/import-rows';
import { ENTITY_DEFS, type ImportEntity } from '@/lib/import-schema';

/**
 * Upload, check, then import.
 *
 * The check runs *in the browser*. `lib/csv.ts` and `lib/import-rows.ts`
 * deliberately import nothing that reaches Postgres, which means the same
 * code that judges a row on the server can judge it here — so the preview
 * cannot promise something the import then refuses, and an operator fixing a
 * 195-row spreadsheet gets an answer immediately rather than one upload at a
 * time.
 *
 * The server validates again on import regardless. This is a courtesy, not a
 * control.
 */

const PREVIEW_ROWS = 20;

interface CheckResult {
  headers: string[];
  rows: Array<Record<string, string>>;
  errors: RowError[];
  validCount: number;
  fatal: string | null;
}

function check(entity: ImportEntity, text: string): CheckResult {
  try {
    const parsed = parseCsv(text);
    const validate =
      entity === 'drivers'
        ? validateDriverRow
        : entity === 'vehicles'
          ? validateVehicleRow
          : validateClientRow;

    const outcomes = parsed.rows.map((row, index) =>
      validate(row, parsed.lineNumbers[index] ?? index + 2),
    );

    const keyOf = (value: unknown): string => {
      const row = value as Record<string, string>;
      return (
        row.normalisedPhone ?? row.normalisedRegistration ?? row.matchKey ?? ''
      );
    };
    const duplicates = findDuplicatesInFile(outcomes, keyOf);
    const duplicateLines = new Set(duplicates.map((error) => error.line));

    return {
      headers: parsed.headers,
      rows: parsed.rows,
      errors: [...outcomes.flatMap((o) => o.errors), ...duplicates],
      validCount: outcomes.filter(
        (o) => o.value && !duplicateLines.has(o.line),
      ).length,
      fatal: null,
    };
  } catch (error) {
    return {
      headers: [],
      rows: [],
      errors: [],
      validCount: 0,
      fatal:
        error instanceof CsvError
          ? error.message
          : 'That file could not be read as CSV.',
    };
  }
}

export function ImportPanel({
  entity,
  error,
  summary,
}: {
  entity: ImportEntity;
  error?: string | null;
  summary?: {
    created: number;
    updated: number;
    skipped: number;
    errorCount: number;
    fileName: string;
  } | null;
}) {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [fileName, setFileName] = useState('');
  const def = ENTITY_DEFS[entity];

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setResult(null);
      setFileName('');
      return;
    }
    setFileName(file.name);
    setResult(check(entity, await file.text()));
  }

  return (
    <div className="space-y-6" data-testid="import-panel">
      {error ? (
        <Alert variant="destructive" data-testid="import-error">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {summary ? (
        <Alert data-testid="import-summary">
          <CheckCircle2 />
          <AlertDescription>
            <span className="font-medium">{summary.fileName}</span> imported:{' '}
            {summary.created} created, {summary.updated} updated,{' '}
            {summary.skipped} skipped.
            {summary.errorCount > 0 ? (
              <>
                {' '}
                {summary.errorCount} problem
                {summary.errorCount === 1 ? '' : 's'} — the report below lists
                each one.
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline">
          <a href={`/api/import/template?entity=${entity}`}>
            <Download aria-hidden />
            Download the {def.label.toLowerCase()} template
          </a>
        </Button>
        <p className="text-sm text-muted-foreground">
          Matched on {def.naturalKey} — importing the same file twice updates
          rather than duplicating.
        </p>
      </div>

      <form
        method="post"
        action={`/api/import?entity=${entity}`}
        encType="multipart/form-data"
        className="space-y-4 rounded-lg border p-4"
        data-testid="import-form"
      >
        <div>
          <label htmlFor="file" className="mb-1 block text-sm font-medium">
            CSV file
          </label>
          <Input
            id="file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Checked here before anything is sent. Nothing is written until you
            press Import.
          </p>
        </div>

        {result?.fatal ? (
          <Alert variant="destructive" data-testid="preview-fatal">
            <AlertCircle />
            <AlertDescription>{result.fatal}</AlertDescription>
          </Alert>
        ) : null}

        {result && !result.fatal ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success" data-testid="preview-valid">
                {result.validCount} ready to import
              </Badge>
              {result.errors.length > 0 ? (
                <Badge variant="warning" data-testid="preview-problems">
                  {result.errors.length} problem
                  {result.errors.length === 1 ? '' : 's'}
                </Badge>
              ) : null}
              <span className="text-muted-foreground">
                {result.rows.length} row{result.rows.length === 1 ? '' : 's'} in{' '}
                {fileName}
              </span>
            </div>

            {result.errors.length > 0 ? (
              <div className="rounded-md border">
                <p className="border-b px-3 py-2 text-sm font-medium">
                  Problems
                </p>
                <ul
                  className="max-h-60 divide-y overflow-y-auto text-sm"
                  data-testid="preview-errors"
                >
                  {result.errors.slice(0, 100).map((problem, index) => (
                    <li
                      key={`${problem.line}-${problem.column}-${index}`}
                      className="flex gap-3 px-3 py-2"
                    >
                      <span className="tabular shrink-0 text-muted-foreground">
                        Row {problem.line}
                      </span>
                      {problem.column ? (
                        <span className="shrink-0 font-medium">
                          {problem.column}
                        </span>
                      ) : null}
                      <span>{problem.message}</span>
                    </li>
                  ))}
                </ul>
                {result.errors.length > 100 ? (
                  <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                    …and {result.errors.length - 100} more. Fix these first —
                    they are often the same mistake repeated.
                  </p>
                ) : null}
              </div>
            ) : null}

            {result.rows.length > 0 ? (
              <div className="overflow-x-auto rounded-md border">
                <p className="border-b px-3 py-2 text-sm font-medium">
                  First {Math.min(PREVIEW_ROWS, result.rows.length)} rows
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {result.headers.map((header) => (
                        <TableHead key={header}>{header}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                      <TableRow key={index}>
                        {result.headers.map((header) => (
                          <TableCell
                            key={header}
                            className="whitespace-nowrap text-muted-foreground"
                          >
                            {row[header] || '—'}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="flex items-center gap-3 border-t pt-4">
          <Button
            type="submit"
            // Nothing to import is not an error, but it is not a click worth
            // making either.
            disabled={Boolean(result?.fatal) || result?.validCount === 0}
          >
            <Upload aria-hidden />
            {result
              ? `Import ${result.validCount} row${result.validCount === 1 ? '' : 's'}`
              : 'Import'}
          </Button>
          {result && result.errors.length > 0 && result.validCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              The rows with problems are skipped. Fix them and re-run the same
              file — it will update rather than duplicate.
            </p>
          ) : null}
        </div>
      </form>

      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Columns for {def.label.toLowerCase()}
        </summary>
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Example</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {def.columns.map((column) => (
              <TableRow key={column.key}>
                <TableCell className="font-medium">{column.label}</TableCell>
                <TableCell className="text-muted-foreground">
                  {column.required ? 'Yes' : '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {column.example}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {column.hint ?? ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </div>
  );
}

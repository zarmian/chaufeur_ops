'use client';

import { AlertCircle, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { FormField, fieldProps } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  deleteDocumentAction,
  uploadDocumentAction,
} from '@/app/(dashboard)/documents/actions';
import { INITIAL_FORM_STATE } from '@/lib/form-state';

export interface DocumentRow {
  id: string;
  type: string;
  typeLabel: string;
  fileName: string;
  sizeBytes: number;
  expiresOn: string | null;
  uploadedAt: string;
  requiresExpiry: boolean;
}

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Uploading…' : 'Upload document'}
    </Button>
  );
}

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="ghost"
      size="icon"
      disabled={pending}
      aria-label="Delete document"
    >
      <Trash2 />
    </Button>
  );
}

function DeleteForm({
  documentId,
  returnPath,
}: {
  documentId: string;
  returnPath: string;
}) {
  const [, formAction] = useActionState(
    deleteDocumentAction.bind(null, documentId, returnPath),
    INITIAL_FORM_STATE,
  );
  return (
    <form action={formAction}>
      <DeleteButton />
    </form>
  );
}

export function DocumentPanel({
  owner,
  documents,
  types,
  returnPath,
  canUpload,
  canDelete,
  storageConfigured,
}: {
  owner: { driverId?: string; vehicleId?: string };
  documents: DocumentRow[];
  types: Array<{ value: string; label: string; requiresExpiry: boolean }>;
  returnPath: string;
  canUpload: boolean;
  canDelete: boolean;
  storageConfigured: boolean;
}) {
  const [state, formAction] = useActionState(
    uploadDocumentAction.bind(null, owner),
    INITIAL_FORM_STATE,
  );
  const errors = state.fields ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Documents</CardTitle>
        <CardDescription>
          The scans behind the expiry dates. Uploading one with an expiry
          updates the date on this record.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing filed yet.
          </p>
        ) : (
          <ul className="divide-y">
            {documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <FileText
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <a
                      // Resolves to a 15-minute signed URL server-side.
                      href={`/api/documents/${document.id}/url`}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {document.typeLabel}
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {document.fileName} ·{' '}
                      {(document.sizeBytes / 1024).toFixed(0)} KB · uploaded{' '}
                      {document.uploadedAt}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {document.expiresOn ? (
                    <span className="text-xs tabular text-muted-foreground">
                      Expires {document.expiresOn}
                    </span>
                  ) : document.requiresExpiry ? (
                    <Badge variant="secondary">No expiry recorded</Badge>
                  ) : null}
                  {canDelete ? (
                    <DeleteForm
                      documentId={document.id}
                      returnPath={returnPath}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canUpload ? (
          <form action={formAction} className="space-y-4 border-t pt-5">
            {state.error ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            ) : null}

            {!storageConfigured ? (
              <Alert variant="warning">
                <AlertCircle />
                <AlertDescription>
                  File storage is not configured. Create a Vercel Blob store to
                  enable uploads — the expiry dates on this record work either
                  way.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField name="type" label="Document type" errors={errors.type}>
                <Select {...fieldProps('type', errors.type)} defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {types.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                      {type.requiresExpiry ? ' (expiry required)' : ''}
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField
                name="expiresOn"
                label="Expires"
                hint="Required for licences, MOT and insurance."
                errors={errors.expiresOn}
              >
                <Input
                  {...fieldProps('expiresOn', errors.expiresOn)}
                  type="date"
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField name="issuedOn" label="Issued" errors={errors.issuedOn}>
                <Input
                  {...fieldProps('issuedOn', errors.issuedOn)}
                  type="date"
                />
              </FormField>

              <FormField
                name="mode"
                label="If one already exists"
                errors={errors.mode}
              >
                <Select {...fieldProps('mode', errors.mode)} defaultValue="replace">
                  <option value="replace">Replace it (the old one is kept)</option>
                  <option value="keep">Keep both</option>
                </Select>
              </FormField>
            </div>

            <FormField
              name="file"
              label="File"
              hint="JPEG, PNG, WebP or PDF, up to 10 MB."
              errors={errors.file}
            >
              <Input
                {...fieldProps('file', errors.file)}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                required
              />
            </FormField>

            <div className="flex items-center gap-2">
              <Paperclip className="size-4 text-muted-foreground" aria-hidden />
              <UploadButton />
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

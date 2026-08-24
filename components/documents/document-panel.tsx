'use client';

import { upload } from '@vercel/blob/client';
import { AlertCircle, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useActionState, useState, useTransition } from 'react';
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
  recordDocumentAction,
} from '@/app/(dashboard)/documents/actions';
import { INITIAL_FORM_STATE, type FormState } from '@/lib/form-state';
import {
  buildObjectKey,
  describeUploadRefusal,
} from '@/lib/storage-keys';

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

/**
 * Not `useFormStatus`, because this form no longer posts.
 *
 * The file goes to Blob storage from here, and only then is a Server Action
 * called to write the row — so "pending" spans two steps the form element
 * knows nothing about, and the percentage comes from the upload itself.
 */
function UploadButton({
  busy,
  progress,
  disabled,
}: {
  busy: boolean;
  progress: number | null;
  disabled: boolean;
}) {
  return (
    <Button type="submit" disabled={busy || disabled}>
      {busy
        ? progress === null
          ? 'Saving…'
          : `Uploading… ${progress}%`
        : 'Upload document'}
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

/**
 * Turn a failed upload into something an operator can act on.
 *
 * The Blob SDK discards the response body when the token route refuses and
 * throws `Failed to retrieve the client token` — true, and useless to
 * somebody trying to file an MOT certificate. Our route's real reasons
 * (the wrong record, an expired token, storage not configured) never reach
 * here, so this says what to do instead of what happened.
 */
function explainUploadFailure(error: unknown, storageConfigured: boolean): string {
  const message = error instanceof Error ? error.message : '';

  if (/client token/i.test(message)) {
    return storageConfigured
      ? 'That upload was not authorised. Refresh the page and try again.'
      : 'File storage is not configured yet. Create a Vercel Blob store and redeploy — the expiry dates on this record still work without it.';
  }

  return message || 'That file could not be uploaded. Try again.';
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
  const [state, setState] = useState<FormState>(INITIAL_FORM_STATE);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, startTransition] = useTransition();
  const errors = state.fields ?? {};

  /**
   * Pick up an obviously wrong file the moment it is chosen.
   *
   * The token and the Server Action both check this again — this one is only
   * so that somebody who has picked a 40 MB scan finds out now rather than
   * after watching a progress bar climb for a minute.
   */
  function checkChosenFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const refusal = describeUploadRefusal({ type: file.type, size: file.size });
    setState(refusal ? { error: refusal } : INITIAL_FORM_STATE);
  }

  /**
   * Upload to Blob storage, then record the row.
   *
   * Two steps, in this order, because the file cannot come through the
   * server: a Server Action's body is capped at 1 MB by default and a Vercel
   * Function's at 4.5 MB, and a scanned certificate is routinely more than
   * either. Uploads under a megabyte used to work and everything larger died
   * in the framework, showing the operator the error boundary with no reason
   * on it — which is what made it look intermittent.
   *
   * If the upload succeeds and recording fails, the object is left in storage
   * with no row pointing at it. That is the right way round: an orphaned
   * object costs pennies and can be swept up, whereas a row pointing at a
   * file that was never stored is a document the compliance screen believes
   * in and nobody can open.
   */
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get('file');

    if (!(file instanceof File) || file.size === 0) {
      setState({ error: 'Choose a file to upload' });
      return;
    }

    const refusal = describeUploadRefusal({ type: file.type, size: file.size });
    if (refusal) {
      setState({ error: refusal });
      return;
    }

    if (!storageConfigured) {
      setState({
        error:
          'File storage is not configured yet. Create a Vercel Blob store and redeploy — the expiry dates on this record still work without it.',
      });
      return;
    }

    setState(INITIAL_FORM_STATE);
    setProgress(0);

    let key: string;
    try {
      const entityType = owner.driverId ? 'driver' : 'vehicle';
      const entityId = owner.driverId ?? owner.vehicleId ?? '';
      // The key is built here and vouched for there: the route refuses to
      // sign anything outside this record's own folder.
      key = buildObjectKey(entityType, entityId, crypto.randomUUID(), file.name);

      await upload(key, file, {
        access: 'private',
        handleUploadUrl: '/api/documents/upload',
        clientPayload: JSON.stringify(owner),
        contentType: file.type,
        onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
      });
    } catch (error) {
      setProgress(null);
      setState({ error: explainUploadFailure(error, storageConfigured) });
      return;
    }

    // Uploaded. Null rather than 100 so the button reads "Saving…" for the
    // step that is actually still running.
    setProgress(null);

    // The file itself never reaches the action — only its key and the fields.
    formData.delete('file');
    formData.set('fileKey', key);
    formData.set('fileName', file.name);

    startTransition(async () => {
      const result = await recordDocumentAction(owner, INITIAL_FORM_STATE, formData);
      setState(result);
      if (!result.error) form.reset();
    });
  }

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
          <form onSubmit={submit} className="space-y-4 border-t pt-5">
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
                onChange={checkChosenFile}
                required
              />
            </FormField>

            <div className="flex items-center gap-2">
              <Paperclip className="size-4 text-muted-foreground" aria-hidden />
              <UploadButton
                busy={busy || progress !== null}
                progress={progress}
                disabled={!storageConfigured}
              />
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

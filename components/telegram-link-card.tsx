import { Send } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * The driver's Telegram link, on their record — spec 5.2.1 and 5.2.2.
 *
 * The generated link is shown once, in a field the operator can copy from.
 * Not stored anywhere readable afterwards, and not emailed: a link that binds
 * a phone to a driver's jobs and pay should have exactly one journey, from
 * this screen to that driver.
 */
export function TelegramLinkCard({
  driverId,
  driverName,
  linkedAt,
  url,
  token,
  expiresAt,
  error,
  canEdit,
  botConfigured,
}: {
  driverId: string;
  driverName: string;
  linkedAt: Date | null;
  url: string | null;
  token: string | null;
  expiresAt: string | null;
  error: string | null;
  canEdit: boolean;
  botConfigured: boolean;
}) {
  const action = `/api/drivers/${driverId}/telegram`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="size-4" aria-hidden />
          Telegram
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error ? (
          <Alert variant="destructive" data-testid="telegram-link-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {linkedAt ? (
          <>
            <p>
              Linked{' '}
              <span className="tabular">{linkedAt.toISOString().slice(0, 10)}</span>.{' '}
              {driverName} receives jobs and reports status in Telegram.
            </p>
            {canEdit ? (
              <form method="post" action={action}>
                <input type="hidden" name="intent" value="unlink" />
                <Button type="submit" variant="outline" size="sm">
                  Unlink
                </Button>
              </form>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              Not linked. Until they link, jobs reach them however they do now — the
              dispatch view flags it.
            </p>

            {!botConfigured ? (
              <Alert>
                <AlertDescription>
                  Set the ops bot username in{' '}
                  <span className="font-medium">Settings → Telegram</span> first, or the
                  link cannot be built.
                </AlertDescription>
              </Alert>
            ) : null}

            {canEdit ? (
              <form method="post" action={action}>
                <input type="hidden" name="intent" value="link" />
                <Button type="submit" size="sm" disabled={!botConfigured}>
                  Generate link
                </Button>
              </form>
            ) : null}
          </>
        )}

        {/* Shown once, right after generating. Copied from here into a text
            message — there is no second chance to read it. */}
        {url || token ? (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="font-medium">Send this to {driverName}</p>
            {/* `defaultValue`, not `value`: a read-only field with `value`
                and no handler is a controlled input React warns about, and
                this component has no reason to be a Client Component. */}
            <Input
              readOnly
              defaultValue={url ?? token ?? ''}
              data-testid="telegram-link-url"
            />
            <p className="text-xs text-muted-foreground">
              Valid until {expiresAt}. It works once, and only for this driver. It is
              not shown again — generate a new one if it goes astray.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

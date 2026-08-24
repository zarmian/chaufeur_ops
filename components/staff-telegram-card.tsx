import { Send } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * A staff member's own Telegram link — spec 5.9.1.
 *
 * Deliberately not the driver's card next door, despite looking like it. A
 * driver has no login, so ops generates their link and sends it; staff all
 * have logins, so nobody needs to hand anybody anything. This card only ever
 * mints a link for **the person looking at it**, which is why the copy says
 * "you" and why an administrator viewing somebody else's record gets the
 * revoke button and nothing else.
 *
 * The link is shown once, in a field to copy from. It is not emailed and not
 * stored anywhere readable: it binds a phone to an account that, for an ADMIN
 * or ACCOUNTS user, answers with the day's revenue.
 */
export function StaffTelegramCard({
  linkedAt,
  url,
  token,
  expiresAt,
  error,
  botConfigured,
  action,
}: {
  linkedAt: Date | null;
  url?: string | null;
  token?: string | null;
  expiresAt?: string | null;
  error?: string | null;
  botConfigured: boolean;
  action: string;
}) {
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
          <Alert variant="destructive" data-testid="staff-telegram-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {linkedAt ? (
          <>
            <p data-testid="staff-telegram-linked">
              Linked{' '}
              <span className="tabular">{linkedAt.toISOString().slice(0, 10)}</span>. Send{' '}
              <code>/help</code> to the staff bot for what it can tell you.
            </p>
            <form method="post" action={action}>
              <input type="hidden" name="intent" value="unlink" />
              <Button type="submit" variant="outline" size="sm">
                Unlink
              </Button>
            </form>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              Not linked. Link your Telegram and the staff bot will answer questions
              about the day&rsquo;s jobs from your phone — read-only, and only what your
              role can already see.
            </p>

            {!botConfigured ? (
              <Alert>
                <AlertDescription>
                  An administrator needs to set the admin bot username in{' '}
                  <span className="font-medium">Settings → Telegram</span> before a link
                  can be built.
                </AlertDescription>
              </Alert>
            ) : null}

            <form method="post" action={action}>
              <input type="hidden" name="intent" value="link" />
              <Button type="submit" size="sm" disabled={!botConfigured}>
                Generate link
              </Button>
            </form>
          </>
        )}

        {/* Shown once, immediately after generating. Opened on the phone that
            is to be linked — there is no second chance to read it. */}
        {url || token ? (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="font-medium">Open this on your phone</p>
            {/* `defaultValue`, not `value`: a read-only field with `value` and
                no handler is a controlled input React warns about, and this
                component has no reason to be a Client Component. */}
            <Input readOnly defaultValue={url ?? token ?? ''} data-testid="staff-telegram-url" />
            <p className="text-xs text-muted-foreground">
              Valid until {expiresAt}. It works once, and only for your account. It is
              not shown again — generate a new one if it goes astray.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The same account seen by an administrator, on somebody else's record.
 *
 * Revoke only. A link generated for another person is a link that has to
 * travel to them somehow, and every route it could take is worse than them
 * pressing the button themselves on a screen they can already reach.
 */
export function StaffTelegramAdminCard({
  name,
  linkedAt,
  error,
  action,
}: {
  name: string;
  linkedAt: Date | null;
  error?: string | null;
  action: string;
}) {
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
          <Alert variant="destructive" data-testid="staff-telegram-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {linkedAt ? (
          <>
            <p data-testid="staff-telegram-linked">
              Linked{' '}
              <span className="tabular">{linkedAt.toISOString().slice(0, 10)}</span>.{' '}
              {name} can ask the staff bot about the day&rsquo;s jobs from their phone.
            </p>
            <form method="post" action={action}>
              <input type="hidden" name="intent" value="unlink" />
              <Button type="submit" variant="outline" size="sm">
                Unlink
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              Revoke this when somebody leaves. Deactivating the account does it too.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            Not linked. {name} can link their own Telegram from{' '}
            <Link href="/profile" className="underline">
              their profile
            </Link>{' '}
            — a link generated here would have to be sent to them, and the point of it
            is that it never travels.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

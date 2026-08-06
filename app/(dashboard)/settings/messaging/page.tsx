import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getClientMessagingConfig, TEMPLATES } from '@/lib/client-messaging';
import { getEmailConfig } from '@/lib/email-store';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { encryptionAvailable } from '@/lib/secret-store';

export const metadata = { title: 'Client messaging' };

/**
 * What clients are told, and how — spec 5.10.
 *
 * Every template is off. A system that starts texting on install spends its
 * first week apologising, and the operator needs to see one confirmation go
 * out before the rest are turned on.
 */
export default async function MessagingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'messagingError');
  const notice = filterValue(query, 'messagingNotice');

  const [config, email, recent] = await Promise.all([
    getClientMessagingConfig(),
    getEmailConfig(),
    prisma.clientMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { client: { select: { name: true } } },
    }),
  ]);

  const failures = recent.filter((message) => message.status === 'FAILED');

  return (
    <>
      <PageHeader
        title="Client messaging"
        description="Booking confirmations and driver updates, by email and text. All off until you turn them on."
        actions={
          <Button asChild variant="outline">
            <Link href="/settings">
              <ArrowLeft aria-hidden />
              Settings
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="messaging-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert className="mb-6" data-testid="messaging-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!encryptionAvailable() ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            Set <code>SETTINGS_ENCRYPTION_KEY</code> before saving SMS credentials —
            generate one with <code>openssl rand -hex 32</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Spec 5.10.7. A delivery failure that only exists in a log is a
          delivery failure nobody acts on. */}
      {failures.length > 0 ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            {failures.length} of the last {recent.length} messages did not arrive. The
            most recent said: {failures[0]?.failedReason ?? 'no reason recorded'}.
          </AlertDescription>
        </Alert>
      ) : null}

      <form method="post" action="/api/settings/messaging" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Channels
              <Badge variant={email.provider === 'none' ? 'secondary' : 'success'}>
                Email: {email.provider === 'none' ? 'not configured' : email.provider}
              </Badge>
              <Badge variant={config.smsProvider === 'none' ? 'secondary' : 'success'}>
                SMS: {config.smsProvider === 'none' ? 'off' : 'Twilio'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Email is configured in{' '}
              <Link href="/settings/email" className="underline">
                Settings → Email
              </Link>
              . Text messages need a Twilio account.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="smsProvider" className="mb-1 block text-sm font-medium">
                  SMS provider
                </label>
                <Select
                  id="smsProvider"
                  name="smsProvider"
                  defaultValue={config.smsProvider}
                >
                  <option value="none">None — email only</option>
                  <option value="twilio">Twilio</option>
                </Select>
              </div>

              <div>
                <label htmlFor="smsFromNumber" className="mb-1 block text-sm font-medium">
                  From number
                </label>
                <Input
                  id="smsFromNumber"
                  name="smsFromNumber"
                  defaultValue={config.smsFromNumber ?? ''}
                  placeholder="+441234567890"
                />
              </div>

              <div>
                <label htmlFor="smsAccountSid" className="mb-1 block text-sm font-medium">
                  Account SID
                </label>
                <Input
                  id="smsAccountSid"
                  name="smsAccountSid"
                  type="password"
                  autoComplete="off"
                  placeholder={config.smsAccountSet ? '•••••••• (leave blank to keep)' : ''}
                />
              </div>

              <div>
                <label htmlFor="smsAuthToken" className="mb-1 block text-sm font-medium">
                  Auth token
                </label>
                <Input
                  id="smsAuthToken"
                  name="smsAuthToken"
                  type="password"
                  autoComplete="off"
                  placeholder={config.smsAccountSet ? '•••••••• (leave blank to keep)' : ''}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What gets sent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Each client also has their own preference — email, text, both or nothing —
              on their record. Both have to say yes.
            </p>

            {TEMPLATES.map((template) => (
              <div key={template.value} className="flex items-start gap-3">
                {/* An unchecked checkbox submits nothing, so a form of toggles
                    could only ever turn things on. The hidden field is what
                    makes turning one off work. */}
                <input type="hidden" name={template.value} value="false" />
                <input
                  id={template.value}
                  name={template.value}
                  type="checkbox"
                  value="true"
                  defaultChecked={config.enabled[template.value]}
                  className="mt-1 size-4"
                />
                <div>
                  <label htmlFor={template.value} className="text-sm font-medium">
                    {template.label}
                  </label>
                  <p className="text-xs text-muted-foreground">{template.hint}</p>
                </div>
              </div>
            ))}

            <Button type="submit">Save</Button>
          </CardContent>
        </Card>
      </form>

      {/* Spec 5.10.5 — the client-side mirror of the Telegram log. */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent messages</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing sent yet. Every message is recorded here, delivered or not.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {recent.map((message) => (
                <li key={message.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-muted-foreground tabular">
                    {message.createdAt.toISOString().slice(5, 16).replace('T', ' ')}
                  </span>
                  <Badge variant="secondary">{message.channel}</Badge>
                  <Badge
                    variant={message.status === 'SENT' ? 'success' : 'destructive'}
                  >
                    {message.status}
                  </Badge>
                  <span>{message.client?.name ?? message.recipient}</span>
                  <span className="text-muted-foreground">{message.template}</span>
                  {message.failedReason ? (
                    <span className="text-destructive">{message.failedReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

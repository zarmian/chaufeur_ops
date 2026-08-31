import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { encryptionAvailable } from '@/lib/secret-store';
import { getTelegramConfig } from '@/lib/telegram/config';

export const metadata = { title: 'Telegram' };

/**
 * The bot's credentials and what it is allowed to do on its own — spec 5.11.
 *
 * Every automation starts off. A bot that begins messaging drivers the moment
 * a token is pasted is a bot nobody trusts, and the first thing an operator
 * needs is to link one driver and watch what happens.
 */
export default async function TelegramSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'telegramError');
  const notice = filterValue(query, 'telegramNotice');

  const config = await getTelegramConfig();
  const canStoreSecrets = encryptionAvailable();
  const appUrl = process.env.APP_URL?.trim() || null;

  const [linked, total, recent] = await Promise.all([
    prisma.driver.count({ where: { telegramChatId: { not: null } } }),
    prisma.driver.count({ where: { status: 'ACTIVE' } }),
    prisma.telegramUpdate.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Telegram"
        description="Drivers receive jobs and report status here. Optional, and off until you turn it on."
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
        <Alert variant="destructive" className="mb-6" data-testid="telegram-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert className="mb-6" data-testid="telegram-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!canStoreSecrets ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            Set <code>SETTINGS_ENCRYPTION_KEY</code> before saving bot tokens — generate
            one with <code>openssl rand -hex 32</code>. A bot token is a full account,
            and nothing is stored in plaintext.
          </AlertDescription>
        </Alert>
      ) : null}

      <form method="post" action="/api/settings/telegram" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Bots
              <Badge variant={config.enabled ? 'success' : 'secondary'}>
                {config.enabled ? 'On' : 'Off'}
              </Badge>
              <Badge variant="secondary">
                {linked} of {total} drivers linked
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="opsToken" className="mb-1 block text-sm font-medium">
                  Ops bot token
                </label>
                <Input
                  id="opsToken"
                  name="opsToken"
                  type="password"
                  autoComplete="off"
                  placeholder={config.opsTokenSet ? '•••••••• (leave blank to keep)' : ''}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  From @BotFather. Never shown again once saved.
                </p>
              </div>

              <div>
                <label htmlFor="adminToken" className="mb-1 block text-sm font-medium">
                  Admin bot token
                </label>
                <Input
                  id="adminToken"
                  name="adminToken"
                  type="password"
                  autoComplete="off"
                  placeholder={config.adminTokenSet ? '•••••••• (leave blank to keep)' : ''}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  A second bot, so staff alerts and driver jobs stay apart.
                </p>
              </div>

              <div>
                <label htmlFor="opsBotUsername" className="mb-1 block text-sm font-medium">
                  Ops bot username
                </label>
                <Input
                  id="opsBotUsername"
                  name="opsBotUsername"
                  defaultValue={config.opsBotUsername ?? ''}
                  placeholder="YourCompanyOpsBot"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Used to build each driver&rsquo;s personal link.
                </p>
              </div>

              <div>
                <label
                  htmlFor="adminBotUsername"
                  className="mb-1 block text-sm font-medium"
                >
                  Admin bot username
                </label>
                <Input
                  id="adminBotUsername"
                  name="adminBotUsername"
                  defaultValue={config.adminBotUsername ?? ''}
                  placeholder="YourCompanyAdminBot"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Used to build each staff member&rsquo;s link, on their profile.
                </p>
              </div>

              <div>
                <label htmlFor="dispatchChatId" className="mb-1 block text-sm font-medium">
                  Dispatch group chat id
                </label>
                <Input
                  id="dispatchChatId"
                  name="dispatchChatId"
                  defaultValue={config.dispatchChatId ?? ''}
                  placeholder="-1001234567890"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Where alerts go. Without one, alerts are not sent at all.
                </p>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="webhookSecret" className="mb-1 block text-sm font-medium">
                  Webhook secret
                </label>
                <Input
                  id="webhookSecret"
                  name="webhookSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    config.webhookSecretSet ? '•••••••• (leave blank to keep)' : ''
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Sent back by Telegram on every update and checked before the body is
                  read. <code>TELEGRAM_WEBHOOK_SECRET</code> in the environment takes
                  precedence, because the webhook is registered against it at deploy time.
                </p>
              </div>
            </div>

            <Toggle
              name="enabled"
              label="Telegram is on"
              hint="Nothing is sent or received while this is off."
              checked={config.enabled}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What the bot does on its own</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              All off by default. Turn one on, watch it for a week, then turn on the
              next.
            </p>

            <Toggle
              name="notifyOnAssignment"
              label="Send the job when a driver is assigned"
              checked={config.notifyOnAssignment}
            />
            <Toggle
              name="requireAcceptance"
              label="Ask the driver to accept or decline"
              hint="A decline returns the job to the pool. Nothing is reassigned automatically."
              checked={config.requireAcceptance}
            />
            <Toggle
              name="chaseDocuments"
              label="Chase expiring documents"
              hint="Messages the driver at 30, 14 and 7 days, then daily once expired."
              checked={config.chaseDocuments}
            />
            <Toggle
              name="alertUnassigned"
              label="Alert on jobs with no driver"
              checked={config.alertUnassigned}
            />
            <Toggle
              name="requestLocation"
              label="Ask for live location"
              hint="Positions are kept for the retention period below, then purged."
              checked={config.requestLocation}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="acceptanceWindowMinutes"
                  className="mb-1 block text-sm font-medium"
                >
                  Alert if unanswered after (min)
                </label>
                <Input
                  id="acceptanceWindowMinutes"
                  name="acceptanceWindowMinutes"
                  type="number"
                  min={1}
                  max={240}
                  defaultValue={config.acceptanceWindowMinutes}
                />
              </div>
              <div>
                <label
                  htmlFor="unassignedAlertHours"
                  className="mb-1 block text-sm font-medium"
                >
                  Alert if no driver within (hours)
                </label>
                <Input
                  id="unassignedAlertHours"
                  name="unassignedAlertHours"
                  type="number"
                  min={1}
                  max={72}
                  defaultValue={config.unassignedAlertHours}
                />
              </div>
              <div>
                <label
                  htmlFor="locationRetentionDays"
                  className="mb-1 block text-sm font-medium"
                >
                  Keep positions for (days)
                </label>
                <Input
                  id="locationRetentionDays"
                  name="locationRetentionDays"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={config.locationRetentionDays}
                />
              </div>
            </div>

            <Button type="submit">Save</Button>
          </CardContent>
        </Card>
      </form>

      {/* Spec 5.1.4. Registration used to be a `curl` pasted from the
          deployment guide with a token and a URL in it — and a bot has
          exactly one webhook, so getting it wrong points another company's
          drivers at this database. Here the address comes from `APP_URL`
          rather than from anybody's typing. */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Where Telegram delivers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Each bot has one webhook address. Registering points it at this
            install — <span className="tabular">{appUrl ?? 'APP_URL is not set'}</span>{' '}
            — and drops anything Telegram had queued for wherever it pointed before.
          </p>

          {!appUrl ? (
            <Alert variant="destructive">
              <AlertDescription>
                <code>APP_URL</code> is not set, so there is no address to register.
                Set it to this install&rsquo;s own URL and redeploy.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <form method="post" action="/api/settings/telegram/webhook">
              <input type="hidden" name="intent" value="check" />
              <Button type="submit" variant="outline" size="sm">
                Check
              </Button>
            </form>
            <form method="post" action="/api/settings/telegram/webhook">
              <input type="hidden" name="intent" value="register" />
              <Button type="submit" size="sm" disabled={!appUrl}>
                Register webhooks
              </Button>
            </form>
          </div>

          <p className="text-xs text-muted-foreground">
            Never point two installs at one bot. The second registration wins, and
            from that moment the first company&rsquo;s drivers report into the
            second&rsquo;s database with nothing anywhere reporting a fault.
          </p>
        </CardContent>
      </Card>

      {/* Spec 5.1.7. When a driver says "I pressed Arrived", this is the only
          place that can say whether the tap ever reached us. */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Once a driver links, every message and tap is logged here.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {recent.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-muted-foreground tabular">
                    {entry.createdAt.toISOString().slice(11, 19)}
                  </span>
                  <Badge variant="secondary">{entry.kind}</Badge>
                  <span>{entry.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * A checkbox that posts something when off.
 *
 * An unchecked checkbox submits nothing at all, so a form of toggles can only
 * ever turn things on. The hidden field ahead of it is what makes turning one
 * off work.
 */
function Toggle({
  name,
  label,
  hint,
  checked,
}: {
  name: string;
  label: string;
  hint?: string;
  checked: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <input type="hidden" name={name} value="false" />
      <input
        id={name}
        name={name}
        type="checkbox"
        value="true"
        defaultChecked={checked}
        className="mt-1 size-4"
      />
      <div>
        <label htmlFor={name} className="text-sm font-medium">
          {label}
        </label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

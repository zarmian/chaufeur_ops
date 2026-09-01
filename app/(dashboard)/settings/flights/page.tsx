import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getFlightConfig } from '@/lib/flights/store';
import { FLIGHT_PROVIDERS } from '@/lib/flights/types';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { encryptionAvailable } from '@/lib/secret-store';

export const metadata = { title: 'Flight tracking' };

/**
 * Flight tracking settings.
 *
 * Optional, and off until somebody switches it on. The two settings that
 * matter are on this page for a reason: **whether it may rewrite a booking**,
 * and **how far a flight has to move before anybody hears about it**. Both
 * are judgements about this particular operation, and both are wrong if
 * guessed at from outside it.
 */
export default async function FlightSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'flightError');
  const notice = filterValue(query, 'flightNotice');

  const config = await getFlightConfig();
  const canStoreSecrets = encryptionAvailable();
  const providerLabel =
    FLIGHT_PROVIDERS.find((option) => option.value === config.provider)
      ?.label ?? config.provider;

  return (
    <>
      <PageHeader
        title="Flight tracking"
        description="Optional. Airport jobs work exactly as before with this switched off."
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
        <Alert
          variant="destructive"
          className="mb-6"
          data-testid="flight-error"
        >
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert className="mb-6" data-testid="flight-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!canStoreSecrets ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            <code>SETTINGS_ENCRYPTION_KEY</code> is not set, so the provider key
            cannot be stored — nothing is ever written in plaintext. Generate
            one with <code>openssl rand -hex 32</code> and set it on the
            deployment.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="max-w-2xl">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{providerLabel}</CardTitle>
          <Badge variant={config.enabled ? 'success' : 'secondary'}>
            {config.enabled ? 'on' : 'off'}
          </Badge>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            action="/api/settings/flights"
            className="space-y-5"
            data-testid="flight-form"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={config.enabled}
                className="size-4"
              />
              Check flights for upcoming airport jobs
            </label>

            <div>
              <label
                htmlFor="apiKey"
                className="mb-1 block text-sm font-medium"
              >
                Provider key
              </label>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={
                  config.apiKey ? 'Set — leave blank to keep it' : 'Not set'
                }
              />
              <p className="text-muted-foreground mt-1 text-xs">
                A RapidAPI key for AeroDataBox. Every lookup is billed, which is
                what the two intervals below are for.
              </p>
            </div>

            <div className="rounded-md border border-dashed p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  name="autoAdjust"
                  defaultChecked={config.autoAdjust}
                  className="size-4"
                />
                Move the pickup when the flight moves
              </label>
              {/*
                The one setting worth reading twice. Off, everything still
                happens — the delay is found, the office is told — and only
                the rewriting of somebody's booking waits for a person. Worth
                a week of watching the alerts before turning it on.
              */}
              <p className="text-muted-foreground mt-2 text-xs">
                Off by default. With it off the office is still told about every
                delay, and nothing in the diary changes by itself. With it on,
                the pickup keeps the gap somebody booked after the scheduled
                landing, and the driver is sent the new time. Cancellations and
                diversions are never applied automatically.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="minShiftMinutes"
                  className="mb-1 block text-sm font-medium"
                >
                  Ignore movements under (minutes)
                </label>
                <Input
                  id="minShiftMinutes"
                  name="minShiftMinutes"
                  type="number"
                  min={1}
                  defaultValue={config.minShiftMinutes}
                />
              </div>
              <div>
                <label
                  htmlFor="minNoticeMinutes"
                  className="mb-1 block text-sm font-medium"
                >
                  Never pull a pickup earlier than (minutes)
                </label>
                <Input
                  id="minNoticeMinutes"
                  name="minNoticeMinutes"
                  type="number"
                  min={1}
                  defaultValue={config.minNoticeMinutes}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  An early landing inside this window is flagged instead —
                  somebody can ring the driver, and a cron cannot.
                </p>
              </div>
              <div>
                <label
                  htmlFor="lookAheadHours"
                  className="mb-1 block text-sm font-medium"
                >
                  Look ahead (hours)
                </label>
                <Input
                  id="lookAheadHours"
                  name="lookAheadHours"
                  type="number"
                  min={1}
                  defaultValue={config.lookAheadHours}
                />
              </div>
              <div>
                <label
                  htmlFor="refreshMinutes"
                  className="mb-1 block text-sm font-medium"
                >
                  Re-check each flight every (minutes)
                </label>
                <Input
                  id="refreshMinutes"
                  name="refreshMinutes"
                  type="number"
                  min={1}
                  defaultValue={config.refreshMinutes}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Ignored in the hour around landing, where an estimate moves
                  quickly and a stale answer is the expensive one.
                </p>
              </div>
            </div>

            <SubmitButton label="Save" />
          </form>
        </CardContent>
      </Card>
    </>
  );
}

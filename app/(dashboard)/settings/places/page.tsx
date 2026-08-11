import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
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
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getEtaConfig } from '@/lib/eta/store';
import { getPlacesConfig } from '@/lib/places/store';
import { encryptionAvailable } from '@/lib/secret-store';

export const metadata = { title: 'Address search' };

/**
 * Where address suggestions come from — spec 4.8.6.
 *
 * Optional, and useful with nothing configured: postcode lookup needs no key
 * and no billing, and completes and validates a UK postcode well enough to
 * price a job. Google Places is what finds "The Dorchester".
 */
export default async function PlacesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'placesError');
  const notice = filterValue(query, 'placesNotice');
  const etaError = filterValue(query, 'etaError');
  const etaNotice = filterValue(query, 'etaNotice');

  const [config, eta] = await Promise.all([getPlacesConfig(), getEtaConfig()]);
  const canStoreSecrets = encryptionAvailable();

  return (
    <>
      <PageHeader
        title="Address search"
        description="Optional. Without a key, pickup fields still complete UK postcodes and offer saved locations."
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
        <Alert variant="destructive" className="mb-6" data-testid="places-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert className="mb-6" data-testid="places-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!canStoreSecrets ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            Set <code>SETTINGS_ENCRYPTION_KEY</code> before saving a Places key —
            generate one with <code>openssl rand -hex 32</code>. Nothing is stored in
            plaintext, so the key is refused rather than saved unprotected.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Provider
            <Badge variant={config.provider === 'google' ? 'success' : 'secondary'}>
              {config.provider === 'google' ? 'Google Places' : 'Postcode lookup'}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            action="/api/settings/places"
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="provider" className="mb-1 block text-sm font-medium">
                  Suggestions come from
                </label>
                <Select id="provider" name="provider" defaultValue={config.provider}>
                  <option value="postcodes">
                    Postcode lookup — no key, no billing
                  </option>
                  <option value="google">Google Places — needs a key</option>
                </Select>
              </div>

              <div>
                <label htmlFor="country" className="mb-1 block text-sm font-medium">
                  Restrict to country
                </label>
                <Input
                  id="country"
                  name="country"
                  maxLength={2}
                  defaultValue={config.country}
                  placeholder="gb"
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="apiKey" className="mb-1 block text-sm font-medium">
                  Google Places API key
                </label>
                <Input
                  id="apiKey"
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  placeholder={config.keySet ? '•••••••• (leave blank to keep)' : ''}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Stored encrypted and never sent to a browser — every lookup is
                  proxied through this application, because a key in the browser is a
                  key anybody can spend.
                </p>
              </div>

              <div>
                <label htmlFor="biasLat" className="mb-1 block text-sm font-medium">
                  Bias towards latitude
                </label>
                <Input
                  id="biasLat"
                  name="biasLat"
                  defaultValue={config.bias?.lat ?? ''}
                  placeholder="51.5074"
                />
              </div>

              <div>
                <label htmlFor="biasLng" className="mb-1 block text-sm font-medium">
                  and longitude
                </label>
                <Input
                  id="biasLng"
                  name="biasLng"
                  defaultValue={config.bias?.lng ?? ''}
                  placeholder="-0.1278"
                />
              </div>

              <div>
                <label htmlFor="biasRadius" className="mb-1 block text-sm font-medium">
                  within metres
                </label>
                <Input
                  id="biasRadius"
                  name="biasRadius"
                  defaultValue={config.bias?.radiusMetres ?? ''}
                  placeholder="40000"
                />
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              The bias is worth setting: an operator typing “victoria” means the
              station, and without a point to lean on the results are a lottery.
            </p>

            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      <EtaCard
        config={eta}
        canStoreSecrets={canStoreSecrets}
        error={etaError}
        notice={etaNotice}
      />
    </>
  );
}

/**
 * Travel time, which is a different provider and a different bill.
 *
 * On the same screen because both answer questions about places, and an
 * operator setting one up is usually setting up the other. Kept as separate
 * settings because they are separate Google APIs: a key restricted to Places
 * will not compute a route, and finding that out through a silent fallback
 * would be worse than being told here.
 */
function EtaCard({
  config,
  canStoreSecrets,
  error,
  notice,
}: {
  config: { provider: string; keySet: boolean; assumedKmh: number };
  canStoreSecrets: boolean;
  error?: string | null;
  notice?: string | null;
}) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Travel time</CardTitle>
        <CardDescription>
          How long until the driver reaches the pickup, from their last shared
          position. It reaches the client in the “driver on the way” message,
          and the dispatch board, which always estimates locally rather than
          spending a routing call every thirty seconds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive" className="mb-4" data-testid="eta-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert className="mb-4" data-testid="eta-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <form
          method="post"
          action="/api/settings/eta"
          className="space-y-4"
          data-testid="eta-form"
        >
          <div>
            <label htmlFor="etaProvider" className="mb-1 block text-sm font-medium">
              Provider
            </label>
            <Select
              id="etaProvider"
              name="provider"
              defaultValue={config.provider}
              className="max-w-sm"
            >
              <option value="straight-line">
                Estimate from distance — no key, no bill
              </option>
              <option value="google">Google Routes — real drive time with traffic</option>
            </Select>
          </div>

          <div>
            <label htmlFor="etaApiKey" className="mb-1 block text-sm font-medium">
              Google Routes key
            </label>
            <Input
              id="etaApiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              className="max-w-sm"
              placeholder={config.keySet ? 'Stored — leave blank to keep it' : ''}
              disabled={!canStoreSecrets}
            />
            <p className="mt-1 text-sm text-muted-foreground">
              {canStoreSecrets
                ? 'Encrypted before it is stored, and never sent to a browser. The key needs the Routes API enabled — a Places key alone will not do.'
                : 'Set SETTINGS_ENCRYPTION_KEY before a key can be stored. Nothing is kept in plaintext.'}
            </p>
          </div>

          <div>
            <label htmlFor="assumedKmh" className="mb-1 block text-sm font-medium">
              Assumed speed, km/h
            </label>
            <Input
              id="assumedKmh"
              name="assumedKmh"
              inputMode="decimal"
              defaultValue={config.assumedKmh}
              className="max-w-[8rem]"
            />
            <p className="mt-1 text-sm text-muted-foreground">
              Used when there is no routing provider, and whenever one is
              unavailable. Deliberately pessimistic: a car that arrives early
              is a client glancing at the door, one that arrives late is a
              client who was told something untrue.
            </p>
          </div>

          <Button type="submit">Save</Button>
        </form>
      </CardContent>
    </Card>
  );
}

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
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

  const config = await getPlacesConfig();
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
    </>
  );
}

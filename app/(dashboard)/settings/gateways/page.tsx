import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getAllGatewayConfigs } from '@/lib/gateways/store';
import { ENVIRONMENTS, environmentWarning } from '@/lib/gateways/types';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { encryptionAvailable } from '@/lib/secret-store';

export const metadata = { title: 'Payment gateways' };

const LABELS: Record<string, string> = {
  revolut: 'Revolut Business',
  sumup: 'SumUp',
};

/**
 * Payment gateway credentials — spec 4.7.1 and 4.7.2.
 *
 * Both are optional and both are off by default. Recording a payment by hand
 * is the primary path and always works; a gateway only adds a link a client
 * can pay through and a webhook that saves somebody typing the payment in.
 */
export default async function GatewaySettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'gatewayError');
  const notice = filterValue(query, 'gatewayNotice');

  const configs = await getAllGatewayConfigs();
  const canStoreSecrets = encryptionAvailable();

  return (
    <>
      <PageHeader
        title="Payment gateways"
        description="Optional. Manual payment recording works without either of them."
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
        <Alert variant="destructive" className="mb-6" data-testid="gateway-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert className="mb-6" data-testid="gateway-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!canStoreSecrets ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            <code>SETTINGS_ENCRYPTION_KEY</code> is not set, so credentials
            cannot be stored — nothing is ever written in plaintext. Generate
            one with <code>openssl rand -hex 32</code> and set it on the
            deployment.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {configs.map((config) => {
          const warning = environmentWarning(config);
          return (
            <Card key={config.name}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{LABELS[config.name]}</CardTitle>
                <Badge variant={config.enabled ? 'success' : 'secondary'}>
                  {config.enabled ? config.environment : 'off'}
                </Badge>
              </CardHeader>
              <CardContent>
                <form
                  method="post"
                  action="/api/settings/gateways"
                  className="space-y-4"
                  data-testid={`gateway-form-${config.name}`}
                >
                  <input type="hidden" name="gateway" value={config.name} />

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="enabled"
                      defaultChecked={config.enabled}
                      className="size-4"
                    />
                    Enabled
                  </label>

                  <div>
                    <label
                      htmlFor={`env-${config.name}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Environment
                    </label>
                    <Select
                      id={`env-${config.name}`}
                      name="environment"
                      defaultValue={config.environment}
                    >
                      {ENVIRONMENTS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {warning ? (
                    <p className="rounded-md border border-dashed p-2 text-xs text-warning-foreground">
                      {warning}
                    </p>
                  ) : null}

                  {config.name === 'sumup' ? (
                    <div>
                      <label
                        htmlFor="merchantCode"
                        className="mb-1 block text-sm font-medium"
                      >
                        Merchant code
                      </label>
                      <Input
                        id="merchantCode"
                        name="merchantCode"
                        defaultValue={config.merchantCode ?? ''}
                        placeholder="MC12345"
                      />
                    </div>
                  ) : null}

                  <div>
                    <label
                      htmlFor={`key-${config.name}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      API key
                    </label>
                    <Input
                      id={`key-${config.name}`}
                      name="apiKey"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        config.apiKey ? 'Set — leave blank to keep it' : 'Not set'
                      }
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`hook-${config.name}`}
                      className="mb-1 block text-sm font-medium"
                    >
                      Webhook signing secret
                    </label>
                    <Input
                      id={`hook-${config.name}`}
                      name="webhookSecret"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        config.webhookSecret
                          ? 'Set — leave blank to keep it'
                          : 'Not set'
                      }
                    />
                    {/* Without it the webhook endpoint refuses everything,
                        which is the right default: an endpoint that accepted
                        unsigned payments would let anyone mark an invoice
                        paid. */}
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      Point the provider at{' '}
                      <code>/api/payments/webhooks/{config.name}</code>. Until
                      this is set, that endpoint rejects every request.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button type="submit" name="intent" value="save">
                      Save
                    </Button>
                    <Button
                      type="submit"
                      name="intent"
                      value="test"
                      variant="outline"
                    >
                      Test connection
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

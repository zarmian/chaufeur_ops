import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getEmailConfig } from '@/lib/email-store';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { encryptionAvailable } from '@/lib/secret-store';

export const metadata = { title: 'Email' };

/**
 * Where invoices are emailed from.
 *
 * Optional, like the gateways. With nothing configured, sending an invoice
 * still marks it sent and produces a PDF — the operator sends it themselves.
 * Nothing in this system stops working because a mailbox is not set up.
 */
export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'emailError');
  const notice = filterValue(query, 'emailNotice');

  const config = await getEmailConfig();
  const canStoreSecrets = encryptionAvailable();

  return (
    <>
      <PageHeader
        title="Email"
        description="Used to send invoices to the billing address. Everything works without it — you just send the PDF yourself."
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
        <Alert variant="destructive" className="mb-6" data-testid="email-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert className="mb-6" data-testid="email-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {!canStoreSecrets ? (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            <code>SETTINGS_ENCRYPTION_KEY</code> is not set, so an API key
            cannot be stored — nothing is ever written in plaintext. Generate
            one with <code>openssl rand -hex 32</code> and set it on the
            deployment.
          </AlertDescription>
        </Alert>
      ) : null}

      {config.source === 'environment' ? (
        <Alert className="mb-6">
          <AlertDescription>
            Currently using <code>EMAIL_API_KEY</code> and{' '}
            <code>EMAIL_FROM</code> from the environment. Anything saved here
            takes over from them.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Provider</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            action="/api/settings/email"
            className="space-y-4"
            data-testid="email-form"
          >
            <div>
              <label htmlFor="provider" className="mb-1 block text-sm font-medium">
                Provider
              </label>
              <Select id="provider" name="provider" defaultValue={config.provider}>
                <option value="none">None — send invoices by hand</option>
                <option value="resend">Resend</option>
                <option value="postmark">Postmark</option>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="fromAddress"
                  className="mb-1 block text-sm font-medium"
                >
                  From address
                </label>
                <Input
                  id="fromAddress"
                  name="fromAddress"
                  type="email"
                  defaultValue={config.fromAddress}
                  placeholder="billing@example.com"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Must be on a domain the provider has verified, or every send
                  is rejected.
                </p>
              </div>
              <div>
                <label htmlFor="fromName" className="mb-1 block text-sm font-medium">
                  From name
                </label>
                <Input
                  id="fromName"
                  name="fromName"
                  defaultValue={config.fromName ?? ''}
                  placeholder="Accounts"
                />
              </div>
            </div>

            <div>
              <label htmlFor="replyTo" className="mb-1 block text-sm font-medium">
                Reply-to
              </label>
              <Input
                id="replyTo"
                name="replyTo"
                type="email"
                defaultValue={config.replyTo ?? ''}
                placeholder="accounts@example.com"
              />
            </div>

            <div>
              <label htmlFor="apiKey" className="mb-1 block text-sm font-medium">
                API key
              </label>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={config.apiKey ? 'Set — leave blank to keep it' : 'Not set'}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Encrypted before it is stored, and never shown again. Blank
                leaves the existing key alone.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button type="submit" name="intent" value="save">
                Save
              </Button>
              {/* Spec 4.7.2's sibling: verify before trusting it. A test that
                  sent a real email would go to a real client. */}
              <Button type="submit" name="intent" value="test" variant="outline">
                Test connection
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

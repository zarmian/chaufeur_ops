import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/form-field';
import { formatInZone } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { formatMoney } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Locale' };

/**
 * Currency, locale, timezone, tax and distance.
 *
 * A Server Component with a plain form post — nothing here needs to react
 * before it is saved, and the sample below is rendered from the *stored*
 * configuration, which is the thing worth checking.
 *
 * The lists are deliberately short. They are the ones a chauffeur operator
 * plausibly needs, and anything else can be typed: the field validates
 * against the platform's own ICU data rather than a hardcoded allowlist.
 */
const CURRENCIES = ['GBP', 'EUR', 'USD', 'CHF', 'AED', 'AUD', 'CAD'];
const LOCALES = ['en-GB', 'en-US', 'en-IE', 'fr-FR', 'de-DE', 'es-ES', 'nl-NL'];
const TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Australia/Sydney',
];

export default async function LocaleSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const config = await getLocaleConfig();

  const error = filterValue(query, 'localeError');
  const saved = Boolean(filterValue(query, 'updated'));

  const sampleInstant = new Date();

  return (
    <>
      <PageHeader
        title="Locale"
        description="How money, dates and distances are shown, and what the tax is called. UK defaults, held as configuration — a non-UK install is a settings change, not a rebuild."
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="locale-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved && !error ? (
        <Alert className="mb-6" data-testid="locale-saved">
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <form
          method="post"
          action="/api/settings/locale"
          className="max-w-2xl space-y-6"
          data-testid="locale-form"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="currency"
              label="Currency"
              hint="ISO 4217. Amounts are stored as whole minor units either way."
              required
            >
              <Input
                id="currency"
                name="currency"
                list="currency-options"
                defaultValue={config.currency}
                required
                maxLength={3}
                className="uppercase tabular"
              />
              <datalist id="currency-options">
                {CURRENCIES.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
            </FormField>

            <FormField
              name="locale"
              label="Locale"
              hint="BCP 47. Decides number grouping and date order."
              required
            >
              <Input
                id="locale"
                name="locale"
                list="locale-options"
                defaultValue={config.locale}
                required
              />
              <datalist id="locale-options">
                {LOCALES.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </FormField>
          </div>

          <FormField
            name="timeZone"
            label="Timezone"
            hint="IANA. Times are stored in UTC and shown in this zone, so summer time is handled for you."
            required
          >
            <Input
              id="timeZone"
              name="timeZone"
              list="timezone-options"
              defaultValue={config.timeZone}
              required
            />
            <datalist id="timezone-options">
              {TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </FormField>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField name="taxName" label="Tax name" required>
              <Input
                id="taxName"
                name="taxName"
                defaultValue={config.taxName}
                required
                maxLength={40}
              />
            </FormField>

            <FormField name="taxRatePct" label="Default rate (%)" required>
              <Input
                id="taxRatePct"
                name="taxRatePct"
                type="number"
                step="0.001"
                min={0}
                max={100}
                defaultValue={config.taxRatePct}
                required
                className="tabular"
              />
            </FormField>

            <FormField name="distanceUnit" label="Distance">
              <Select
                id="distanceUnit"
                name="distanceUnit"
                defaultValue={config.distanceUnit}
              >
                <option value="miles">Miles</option>
                <option value="kilometres">Kilometres</option>
              </Select>
            </FormField>
          </div>

          <div className="flex items-center gap-3 border-t pt-6">
            <Button type="submit">Save locale</Button>
          </div>
        </form>

        <aside className="h-fit rounded-lg border p-4 text-sm lg:sticky lg:top-6">
          <p className="mb-3 font-medium">As currently saved</p>
          <dl className="space-y-2">
            <Sample
              label="A price"
              value={formatMoney(125550, {
                currency: config.currency,
                locale: config.locale,
              })}
            />
            <Sample
              label="Now, in your timezone"
              value={formatInZone(sampleInstant, {
                locale: config.locale,
                timeZone: config.timeZone,
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            />
            <Sample
              label="Tax"
              value={`${config.taxName} at ${config.taxRatePct}%`}
            />
            <Sample label="Distance" value={config.distanceUnit} />
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Save to see these change. They render from the stored settings, not
            from what is typed above.
          </p>
        </aside>
      </div>
    </>
  );
}

function Sample({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

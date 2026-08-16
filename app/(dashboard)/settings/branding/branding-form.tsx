'use client';

import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  buildPalette,
  checkContrast,
  LIGHT_SURFACE,
  normaliseHex,
  PICKER_FALLBACK,
  readableForeground,
  SUGGESTED_ACCENT,
  SUGGESTED_PRIMARY,
} from '@/lib/colour';

/**
 * The branding screen.
 *
 * A Client Component for one reason: the preview has to react to a colour
 * before it is saved. Picking a brand colour blind, saving, and discovering
 * the button text is unreadable is exactly the loop this avoids.
 *
 * The form itself is a plain multipart POST to a route handler — see
 * `app/api/jobs/[id]/status/route.ts` for why not a Server Action.
 */

export interface BrandingFormValues {
  tradingName: string;
  legalName: string;
  primaryColour: string;
  accentColour: string;
  addressLines: string;
  phone: string;
  supportEmail: string;
  websiteUrl: string;
  taxNumber: string;
  companyNumber: string;
  bankDetails: string;
  invoiceSignatory: string;
  jobReferencePrefix: string;
  invoiceNumberPrefix: string;
}

export function BrandingForm({
  values,
  storageConfigured,
  hasLogoLight,
  hasLogoDark,
  hasFavicon,
  logoLightSrc,
  logoDarkSrc,
  faviconSrc,
  error,
  saved,
  sampleAmount,
}: {
  values: BrandingFormValues;
  storageConfigured: boolean;
  hasLogoLight: boolean;
  hasLogoDark: boolean;
  hasFavicon: boolean;
  logoLightSrc: string | null;
  logoDarkSrc: string | null;
  faviconSrc: string | null;
  error?: string | null;
  saved?: boolean;
  /** A sample amount in the configured currency, for the colour preview. */
  sampleAmount: string;
}) {
  const [primary, setPrimary] = useState(values.primaryColour || SUGGESTED_PRIMARY);
  const [accent, setAccent] = useState(values.accentColour || SUGGESTED_ACCENT);
  const [prefix, setPrefix] = useState(values.jobReferencePrefix);

  return (
    <form
      method="post"
      action="/api/branding"
      encType="multipart/form-data"
      className="space-y-8"
      data-testid="branding-form"
    >
      {error ? (
        <Alert variant="destructive" data-testid="branding-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved && !error ? (
        <Alert data-testid="branding-saved">
          <AlertDescription>
            Saved. The change is live now — no redeploy needed.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-8">
          <Section
            title="The company"
            description="What appears in the sidebar, on the login page, on invoices and in emails."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField name="tradingName" label="Trading name" required>
                <Input
                  id="tradingName"
                  name="tradingName"
                  defaultValue={values.tradingName}
                  required
                  maxLength={120}
                />
              </FormField>
              <FormField
                name="legalName"
                label="Legal name"
                hint="For invoices and statements, if it differs."
              >
                <Input
                  id="legalName"
                  name="legalName"
                  defaultValue={values.legalName}
                  maxLength={160}
                />
              </FormField>
            </div>

            <FormField name="addressLines" label="Address">
              <Textarea
                id="addressLines"
                name="addressLines"
                rows={3}
                defaultValue={values.addressLines}
                maxLength={400}
              />
            </FormField>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField name="phone" label="Phone">
                <Input id="phone" name="phone" defaultValue={values.phone} />
              </FormField>
              <FormField name="supportEmail" label="Support email">
                <Input
                  id="supportEmail"
                  name="supportEmail"
                  type="email"
                  defaultValue={values.supportEmail}
                />
              </FormField>
              <FormField name="websiteUrl" label="Website">
                <Input
                  id="websiteUrl"
                  name="websiteUrl"
                  defaultValue={values.websiteUrl}
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField name="taxNumber" label="Tax registration number">
                <Input
                  id="taxNumber"
                  name="taxNumber"
                  defaultValue={values.taxNumber}
                  className="tabular"
                />
              </FormField>
              <FormField name="companyNumber" label="Company number">
                <Input
                  id="companyNumber"
                  name="companyNumber"
                  defaultValue={values.companyNumber}
                  className="tabular"
                />
              </FormField>
            </div>

            <FormField
              name="bankDetails"
              label="Bank details"
              hint="Printed on invoices. Account name, sort code, account number."
            >
              <Textarea
                id="bankDetails"
                name="bankDetails"
                rows={3}
                defaultValue={values.bankDetails}
                maxLength={600}
              />
            </FormField>

            <FormField
              name="invoiceSignatory"
              label="Invoice signatory"
              hint="Printed under the signature rule on an invoice — a name and a capacity, e.g. “A. Patel, Director”. Leave it blank to print a rule and nothing else."
            >
              <Input
                id="invoiceSignatory"
                name="invoiceSignatory"
                defaultValue={values.invoiceSignatory}
                maxLength={120}
              />
            </FormField>
          </Section>

          <Section
            title="Colours"
            description="One hex value each. Hover, active and focus shades are derived from them, so the whole interface stays coherent."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <ColourField
                name="primaryColour"
                label="Primary"
                hint="Buttons, links and the active sidebar item."
                value={primary}
                onChange={setPrimary}
              />
              <ColourField
                name="accentColour"
                label="Accent"
                hint="Highlighted rows and subtle fills."
                value={accent}
                onChange={setAccent}
              />
            </div>
          </Section>

          <Section
            title="Logos"
            description="The light-background logo appears on white surfaces; the dark one is used in dark mode. Either upload a file or point at one you already host."
          >
            {!storageConfigured ? (
              <Alert variant="warning">
                <AlertDescription>
                  File storage is not set up on this deployment, so files
                  cannot be uploaded here — but you can still set a logo by
                  giving the address of one you already host. To enable
                  uploads, create a Vercel Blob store and set{' '}
                  <code>BLOB_READ_WRITE_TOKEN</code>.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-5">
              <AssetField
                name="logoLightUrl"
                linkName="logoLightLink"
                label="Logo — light background"
                present={hasLogoLight}
                currentSrc={logoLightSrc}
                canUpload={storageConfigured}
              />
              <AssetField
                name="logoDarkUrl"
                linkName="logoDarkLink"
                label="Logo — dark background"
                present={hasLogoDark}
                currentSrc={logoDarkSrc}
                canUpload={storageConfigured}
              />
              <AssetField
                name="faviconUrl"
                linkName="faviconLink"
                label="Favicon"
                present={hasFavicon}
                currentSrc={faviconSrc}
                canUpload={storageConfigured}
              />
            </div>
          </Section>

          <Section
            title="Reference prefixes"
            description="Printed on paperwork, so they are upper-cased and limited to letters and digits."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="jobReferencePrefix"
                label="Job reference"
                required
                hint={`Jobs will read ${(prefix || 'JOB').toUpperCase()}-000767.`}
              >
                <Input
                  id="jobReferencePrefix"
                  name="jobReferencePrefix"
                  value={prefix}
                  onChange={(event) => setPrefix(event.target.value)}
                  required
                  maxLength={8}
                  className="uppercase tabular"
                />
              </FormField>
              <FormField
                name="invoiceNumberPrefix"
                label="Invoice number"
                required
                hint="Existing references keep the prefix they were issued with."
              >
                <Input
                  id="invoiceNumberPrefix"
                  name="invoiceNumberPrefix"
                  defaultValue={values.invoiceNumberPrefix}
                  required
                  maxLength={8}
                  className="uppercase tabular"
                />
              </FormField>
            </div>
          </Section>

          <div className="flex items-center gap-3 border-t pt-6">
            <Button type="submit">Save branding</Button>
            <p className="text-sm text-muted-foreground">
              Takes effect immediately.
            </p>
          </div>
        </div>

        <Preview
          primary={primary}
          accent={accent}
          name={values.tradingName}
          sampleAmount={sampleAmount}
        />
      </div>
    </form>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ColourField({
  name,
  label,
  hint,
  value,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const normalised = normaliseHex(value);

  // Checked as *text on the page*, not as a button fill. Against its own
  // derived foreground a brand colour always passes — the picker chooses the
  // better of black and white — so warning on that pairing would never fire.
  // Used as a link or an active label on white, a pale brand genuinely fails.
  const asText = normalised ? checkContrast(normalised, LIGHT_SURFACE) : null;
  const onFill = normalised
    ? checkContrast(readableForeground(normalised), normalised)
    : null;

  return (
    <FormField name={name} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={normalised ?? PICKER_FALLBACK}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded border bg-background"
        />
        <Input
          id={name}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={SUGGESTED_PRIMARY}
          className="tabular"
        />
      </div>
      {!normalised && value.trim() !== '' ? (
        <p className="mt-1 text-xs text-destructive">
          That is not a hex colour. Use something like #1f6feb.
        </p>
      ) : null}
      {/* Reported, not enforced. A brand colour is the customer's decision —
          but they should learn this here rather than from a user who cannot
          read a link in it. */}
      {asText?.message ? (
        <p
          className="mt-1 text-xs text-warning-foreground"
          data-testid={`${name}-contrast`}
        >
          As text on a white page: {asText.message} Buttons in this colour are
          fine — the label switches to{' '}
          {readableForeground(normalised!) === PICKER_FALLBACK ? 'black' : 'white'}{' '}
          at {onFill?.ratio}:1.
        </p>
      ) : normalised ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Contrast on white: {asText?.ratio}:1. Passes WCAG AA.
        </p>
      ) : null}
    </FormField>
  );
}

/**
 * One logo, settable two ways.
 *
 * The upload is the better option when file storage is available. The typed
 * address is always available, because a deployment without a Blob store
 * still has a company with a logo — gating branding on a piece of storage
 * infrastructure made the white-label promise conditional on something that
 * has nothing to do with it.
 */
function AssetField({
  name,
  linkName,
  label,
  present,
  currentSrc,
  canUpload,
}: {
  name: string;
  linkName: string;
  label: string;
  present: boolean;
  currentSrc: string | null;
  canUpload: boolean;
}) {
  return (
    <div className="rounded-md border p-3" data-testid={`asset-${name}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        {present && currentSrc ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={currentSrc}
              alt={`Current ${label.toLowerCase()}`}
              height={32}
              loading="lazy"
              className="h-8 w-auto max-w-[8rem] object-contain"
            />
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
              <input type="checkbox" name={`${name}Clear`} className="size-3.5" />
              Remove
            </label>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Not set</span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {canUpload ? (
          <div>
            <label
              htmlFor={name}
              className="mb-1 block text-xs text-muted-foreground"
            >
              Upload a file
            </label>
            <Input
              id={name}
              name={name}
              type="file"
              accept="image/svg+xml,image/png,image/jpeg,image/webp"
              className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              SVG, PNG, JPEG or WebP.
            </p>
          </div>
        ) : null}

        <div className={canUpload ? '' : 'sm:col-span-2'}>
          <label
            htmlFor={linkName}
            className="mb-1 block text-xs text-muted-foreground"
          >
            {canUpload ? 'Or link to one you host' : 'Link to one you host'}
          </label>
          <Input
            id={linkName}
            name={linkName}
            type="url"
            inputMode="url"
            placeholder="https://example.com/logo.svg"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Must start https:// — the browser blocks a plain http image on a
            secure page. Leave blank to keep what is set.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * A sample of the interface in the chosen colours.
 *
 * Deliberately the three things most likely to go wrong: a filled button
 * (foreground legibility), a badge (the accent surface) and a table row
 * (whether the highlight is visible at all).
 */
function Preview({
  primary,
  accent,
  name,
  sampleAmount,
}: {
  primary: string;
  accent: string;
  name: string;
  /** Formatted in the install's own currency, not a hardcoded pound sign. */
  sampleAmount: string;
}) {
  const primaryPalette = buildPalette(primary);
  const accentPalette = buildPalette(accent);

  const style = {
    ...(primaryPalette
      ? {
          '--preview-primary': `hsl(${primaryPalette.base})`,
          '--preview-primary-fg': `hsl(${primaryPalette.baseForeground})`,
          '--preview-primary-hover': `hsl(${primaryPalette.hover})`,
        }
      : {}),
    ...(accentPalette
      ? {
          '--preview-accent': `hsl(${accentPalette.muted})`,
          '--preview-accent-fg': `hsl(${accentPalette.mutedForeground})`,
        }
      : {}),
  } as React.CSSProperties;

  return (
    <aside
      className="h-fit rounded-lg border p-4 lg:sticky lg:top-6"
      style={style}
      data-testid="branding-preview"
    >
      <p className="mb-3 text-sm font-medium">Preview</p>

      <div className="space-y-4 text-sm">
        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">Sidebar</p>
          <div
            className="rounded px-3 py-2 font-medium"
            style={{
              background: 'var(--preview-primary)',
              color: 'var(--preview-primary-fg)',
            }}
          >
            {name || 'Operations'}
          </div>
        </div>

        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">Button</p>
          <span
            className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium"
            style={{
              background: 'var(--preview-primary)',
              color: 'var(--preview-primary-fg)',
            }}
          >
            Book job
          </span>
        </div>

        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">Badge and row</p>
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
            style={{
              background: 'var(--preview-accent)',
              color: 'var(--preview-accent-fg)',
            }}
          >
            Assigned
          </span>
          <div
            className="mt-2 flex items-center justify-between rounded px-2 py-1.5 tabular"
            style={{ background: 'var(--preview-accent)' }}
          >
            <span translate="no">JOB-000767</span>
            <span>{sampleAmount}</span>
          </div>
        </div>

        {/* Fixed across every brand: a red that means "expired" must not
            become a customer's colour. */}
        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            Semantic states, unchanged
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="destructive">Expired</Badge>
            <Badge variant="warning">Expiring</Badge>
            <Badge variant="success">In date</Badge>
          </div>
        </div>
      </div>
    </aside>
  );
}

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { brandingSchema } from '../lib/branding';
import { completeInstall, isInstallComplete, MIN_PASSWORD_LENGTH } from '../lib/install';
import { localeSchema } from '../lib/locale-store';
import { DEFAULT_LOCALE_CONFIG } from '../lib/locale';

/**
 * First-run install: `npm run setup`.
 *
 * The same work the `/setup` page does from a browser, for people standing up
 * an install from a terminal. Both paths call `completeInstall`, so the two
 * cannot drift into seeding different things.
 *
 * Safe to re-run. It checks for an existing install first and stops rather
 * than creating a second administrator or overwriting a configured company's
 * branding — a setup script that quietly resets a live install is worse than
 * one that refuses.
 *
 * Nothing here names a customer. Every default is generic.
 */

// Unextended on purpose: setup must see the database as it really is, before
// any soft-delete filtering is meaningful.
const prisma = new PrismaClient();

/**
 * Interactive at a terminal, scriptable from a pipe.
 *
 * Readline emits `close` the moment a piped stdin ends, which rejects any
 * question still pending — so a here-doc would fail partway through with
 * "readline was closed". When stdin is not a TTY the answers are read up
 * front and handed out in order instead, which is what makes the unattended
 * install in `docs/deployment.md` work.
 */
const interactive = stdin.isTTY === true;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

let piped: string[] = [];
let pipedIndex = 0;

async function readPipedAnswers(): Promise<void> {
  if (interactive) return;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';

  if (!interactive) {
    const answer = (piped[pipedIndex] ?? '').trim();
    pipedIndex += 1;
    const resolved = answer === '' ? (fallback ?? '') : answer;
    console.log(`${question}${suffix}: ${resolved}`);
    return resolved;
  }

  const answer = (await rl!.question(`${question}${suffix}: `)).trim();
  return answer === '' ? (fallback ?? '') : answer;
}

async function askRequired(question: string, fallback?: string): Promise<string> {
  for (;;) {
    const answer = await ask(question, fallback);
    if (answer !== '') return answer;
    console.error('  That one is required.');
  }
}

async function askSecret(question: string): Promise<string> {
  // Node's readline cannot mask input without taking over the TTY, and a
  // half-working mask is worse than none — someone would trust it. Said
  // plainly instead.
  if (interactive) {
    console.log('  (typed visibly — clear your scrollback afterwards)');
    return askRequired(question);
  }

  // Piped: echoing it back would put the password in a deployment log.
  const answer = (piped[pipedIndex] ?? '').trim();
  pipedIndex += 1;
  console.log(`${question}: ${'*'.repeat(Math.min(answer.length, 12))}`);
  if (answer === '') fail(`${question} is required.`);
  return answer;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  rl?.close();
  void prisma.$disconnect();
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('\nOperations — first-run setup\n');
  await readPipedAnswers();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    fail(
      'Could not reach the database. Check DATABASE_URL and DIRECT_URL, and that migrations have been applied with `npm run db:deploy`.',
    );
  }

  if (await isInstallComplete()) {
    console.log('This install is already set up.');
    console.log(
      'Nothing has been changed. Sign in and use Settings to adjust branding, locale or thresholds.',
    );
    rl?.close();
    await prisma.$disconnect();
    return;
  }

  // ------------------------------------------------------------ the company
  console.log('The company\n');

  const tradingName = await askRequired('Trading name');
  const legalName = await ask('Legal name (for invoices)', tradingName);
  const supportEmail = await ask('Support email');
  const phone = await ask('Phone');
  const jobReferencePrefix = await ask('Job reference prefix', 'JOB');
  const invoiceNumberPrefix = await ask('Invoice number prefix', 'INV');

  let branding;
  try {
    branding = brandingSchema.parse({
      tradingName,
      legalName,
      supportEmail,
      phone,
      jobReferencePrefix,
      invoiceNumberPrefix,
      primaryColour: '',
      accentColour: '',
      addressLines: '',
      websiteUrl: '',
      taxNumber: '',
      companyNumber: '',
      bankDetails: '',
    });
  } catch (error) {
    fail(
      error instanceof Error
        ? `Those company details were not accepted: ${error.message.slice(0, 300)}`
        : 'Those company details were not accepted',
    );
  }

  // ------------------------------------------------------------- the locale
  console.log('\nLocale — press enter to accept the UK defaults\n');

  const currency = await ask('Currency (ISO 4217)', DEFAULT_LOCALE_CONFIG.currency);
  const locale = await ask('Locale (BCP 47)', DEFAULT_LOCALE_CONFIG.locale);
  const timeZone = await ask('Timezone (IANA)', DEFAULT_LOCALE_CONFIG.timeZone);
  const taxName = await ask('Tax name', DEFAULT_LOCALE_CONFIG.taxName);
  const taxRatePct = await ask(
    'Default tax rate (%)',
    String(DEFAULT_LOCALE_CONFIG.taxRatePct),
  );
  const distanceUnit = await ask(
    'Distance unit (miles or kilometres)',
    DEFAULT_LOCALE_CONFIG.distanceUnit,
  );

  let localeConfig;
  try {
    localeConfig = localeSchema.parse({
      currency,
      locale,
      timeZone,
      taxName,
      taxRatePct,
      distanceUnit,
    });
  } catch (error) {
    fail(
      error instanceof Error
        ? `That locale was not accepted: ${error.message.slice(0, 300)}`
        : 'That locale was not accepted',
    );
  }

  // ------------------------------------------------------- the first admin
  console.log('\nThe first administrator\n');

  const adminName = await askRequired('Name');
  const adminEmail = await askRequired('Email');
  const password = await askSecret(
    `Password (at least ${MIN_PASSWORD_LENGTH} characters)`,
  );

  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`That password is too short. It needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const confirm = await askSecret('Confirm password');
  if (confirm !== password) fail('Those passwords do not match.');

  // ----------------------------------------------------------------- write
  console.log('\nSetting up…');

  const result = await completeInstall({
    email: adminEmail,
    name: adminName,
    password,
  });

  if (!result.ok) {
    fail(
      'Somebody claimed this install while the questions were being answered. Nothing has been changed.',
    );
  }

  // Settings come after the install marker, so a race loses the whole thing
  // rather than leaving a half-branded install with no administrator.
  const settings: Array<{ key: string; value: string | number }> = [
    { key: 'branding.tradingName', value: branding.tradingName },
    ...(branding.legalName
      ? [{ key: 'branding.legalName', value: branding.legalName }]
      : []),
    ...(branding.supportEmail
      ? [{ key: 'branding.supportEmail', value: branding.supportEmail }]
      : []),
    ...(branding.phone ? [{ key: 'branding.phone', value: branding.phone }] : []),
    { key: 'branding.jobReferencePrefix', value: branding.jobReferencePrefix },
    { key: 'branding.invoiceNumberPrefix', value: branding.invoiceNumberPrefix },
    { key: 'locale.currency', value: localeConfig.currency },
    { key: 'locale.locale', value: localeConfig.locale },
    { key: 'locale.timeZone', value: localeConfig.timeZone },
    { key: 'locale.taxName', value: localeConfig.taxName },
    { key: 'locale.taxRatePct', value: localeConfig.taxRatePct },
    { key: 'locale.distanceUnit', value: localeConfig.distanceUnit },
  ];

  await prisma.$transaction(
    settings.map((setting) =>
      prisma.setting.upsert({
        where: { key: setting.key },
        update: { value: setting.value },
        create: { key: setting.key, value: setting.value },
      }),
    ),
  );

  console.log(`
✓ ${branding.tradingName} is set up.

  Administrator   ${adminEmail}
  References      ${branding.jobReferencePrefix}-000001
  Locale          ${localeConfig.currency}, ${localeConfig.timeZone}
  Tax             ${localeConfig.taxName} at ${localeConfig.taxRatePct}%

  Zones and a default rate card are seeded. The fares are zero — set the
  real ones in Settings before invoicing.

Next:
  1. Sign in and open Settings → Branding to add logos and colours.
  2. Settings → Import to load drivers, vehicles and clients from CSV.
     Load the vehicles first; the driver file can then name a car by
     registration and link the two in one pass.
`);

  rl?.close();
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('\n✗ Setup failed.');
  console.error(error instanceof Error ? error.message : error);
  rl?.close();
  await prisma.$disconnect();
  process.exit(1);
});

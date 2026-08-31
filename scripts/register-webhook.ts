/**
 * Point this install's bots at this install.
 *
 * `npx tsx scripts/register-webhook.ts`
 *
 * Spec 5.1.4 asked for a setup script and this is it. The same work is
 * available as a button in Settings → Telegram; the script exists for the
 * deploy that has no browser in front of it, and for the checklist.
 *
 * It reads `APP_URL`, the bot tokens from Settings, and the webhook secret —
 * so there is nothing to paste and nothing to get one character wrong. That
 * is the point: a bot has exactly one webhook, and a hand-typed registration
 * against the wrong install silently sends another company's drivers here.
 */
import { registerConfiguredWebhooks } from '../lib/telegram/webhook-admin';

async function main(): Promise<void> {
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) {
    console.error(
      'APP_URL is not set. There is no address to register — set it to this install’s own URL first.',
    );
    process.exit(1);
  }

  console.log(`Registering webhooks against ${appUrl}\n`);

  const outcomes = await registerConfiguredWebhooks();

  if (outcomes.length === 0) {
    console.log('No bot token is configured, so there is nothing to register.');
    return;
  }

  let failed = false;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      console.log(`✓ ${outcome.bot.padEnd(5)} → ${outcome.url}`);
    } else {
      failed = true;
      console.error(`✗ ${outcome.bot.padEnd(5)} ${outcome.message}`);
    }
  }

  if (failed) process.exit(1);
  console.log('\nRun `npx tsx scripts/verify-install.ts` to confirm.');
}

void main();

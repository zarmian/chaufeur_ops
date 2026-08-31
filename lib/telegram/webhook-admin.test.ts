import { describe, expect, it } from 'vitest';
import { webhookPathFor, webhookUrlFor } from './webhook-admin';

/**
 * Where a bot's updates are told to go.
 *
 * The rest of `webhook-admin` talks to Telegram and is exercised against a
 * real bot in `verify-install`; what is worth pinning without a network is
 * the address itself, because getting it wrong is the failure the whole
 * feature exists to prevent. A webhook registered one character out is a bot
 * that appears configured, accepts a token, reports "ok", and delivers
 * nothing — or worse, delivers to another install.
 */

describe('the address each bot is registered against', () => {
  it('sends drivers and staff to their own endpoints', () => {
    // Two bots, two tokens, two webhooks. Sharing an endpoint would mean one
    // compromised token reaching both audiences.
    expect(webhookPathFor('ops')).toBe('/api/telegram/webhook');
    expect(webhookPathFor('admin')).toBe('/api/telegram/admin-webhook');
  });

  it('joins the app URL to the path without doubling the slash', () => {
    expect(webhookUrlFor('ops', 'https://ops.example.com')).toBe(
      'https://ops.example.com/api/telegram/webhook',
    );
    // An APP_URL pasted with a trailing slash is the commonest way to type it.
    expect(webhookUrlFor('ops', 'https://ops.example.com/')).toBe(
      'https://ops.example.com/api/telegram/webhook',
    );
    expect(webhookUrlFor('admin', 'https://ops.example.com///')).toBe(
      'https://ops.example.com/api/telegram/admin-webhook',
    );
  });

  it('keeps a port, for an install behind one', () => {
    expect(webhookUrlFor('ops', 'https://ops.example.com:8443')).toBe(
      'https://ops.example.com:8443/api/telegram/webhook',
    );
  });
});

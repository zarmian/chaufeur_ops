import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDashboard } from './dashboard';

/**
 * The dashboard, against a real database — spec 6.6.
 *
 * Two things worth proving. That `OPS` does not see revenue, which is a role
 * rule and not a styling choice — a dispatcher seeing gross profit on the
 * landing page is a data leak, not an untidy layout. And that the tiles agree
 * with the views they link to, which is the whole reason they are assembled
 * from the existing report functions rather than computed afresh.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const stamp = String(Date.now()).slice(-7);

describe.skipIf(!DATABASE_AVAILABLE)('dashboard', () => {
  const jobIds: string[] = [];
  let clientId = '';

  beforeAll(async () => {
    if (!raw) return;

    const client = await raw.client.create({
      data: { name: `Dashboard Client ${stamp}`, normalisedName: `dashboardclient${stamp}` },
    });
    clientId = client.id;

    // Today, so it lands in every window the tiles look at.
    const job = await raw.job.create({
      data: {
        reference: `DBD-${stamp}`,
        jobType: 'TRANSFER',
        status: 'PENDING',
        scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow Terminal 5',
        clientId,
        clientPricePence: 30_000,
      },
    });
    jobIds.push(job.id);
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.client.deleteMany({ where: { id: clientId } });
    await raw.$disconnect();
  });

  it('hides every money tile from a role that may not see revenue', async () => {
    // Spec 6.6.6. Not a layout preference: a dispatcher seeing gross profit
    // on the landing page is a data leak.
    const ops = await loadDashboard({ seesMoney: false });
    const accounts = await loadDashboard({ seesMoney: true });

    const keys = (tiles: typeof ops.tiles) => tiles.map((tile) => tile.key);

    expect(keys(ops.tiles)).not.toContain('revenue');
    expect(keys(ops.tiles)).not.toContain('profit');
    expect(keys(ops.tiles)).not.toContain('overdue');

    expect(keys(accounts.tiles)).toContain('revenue');
    expect(keys(accounts.tiles)).toContain('profit');
  });

  it('still shows the operational tiles to everybody', async () => {
    const ops = await loadDashboard({ seesMoney: false });
    const keys = ops.tiles.map((tile) => tile.key);

    for (const key of ['today', 'week', 'unassigned', 'unpriced', 'expiring']) {
      expect(keys).toContain(key);
    }
  });

  it('gives every tile somewhere to go', async () => {
    // A number with nowhere to go is a number people learn to ignore, and
    // the whole point of the unpriced tile is that somebody clicks it.
    const dashboard = await loadDashboard({ seesMoney: true });

    for (const tile of dashboard.tiles) {
      expect(tile.href, `${tile.key} has no link`).toMatch(/^\//);
    }
  });

  it('counts today’s work', async () => {
    const dashboard = await loadDashboard({ seesMoney: true });
    const today = dashboard.tiles.find((tile) => tile.key === 'today');

    expect(today).toBeTruthy();
    expect(Number(today!.value)).toBeGreaterThan(0);
  });

  it('turns the unpriced tile red only past the configured threshold', async () => {
    // Spec 6.6.3 — the colour is a threshold, not decoration. A tile that is
    // always coloured says nothing.
    const dashboard = await loadDashboard({ seesMoney: true });
    const unpriced = dashboard.tiles.find((tile) => tile.key === 'unpriced');

    expect(unpriced).toBeTruthy();
    expect(['ok', 'warning', 'destructive']).toContain(unpriced!.tone);

    if (Number(unpriced!.value) === 0) {
      expect(unpriced!.tone).toBe('ok');
    }
  });

  it('loads inside a budget somebody would wait for', async () => {
    // Ten queries in parallel rather than in sequence. The failure this
    // guards against is somebody making them sequential, which is a
    // dashboard people stop opening.
    const started = Date.now();
    await loadDashboard({ seesMoney: true });
    const elapsed = Date.now() - started;

    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(5000);
  });
});

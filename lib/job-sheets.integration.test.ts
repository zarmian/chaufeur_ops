import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rawPrismaClient } from './raw-prisma';

/**
 * A job sheet from its bytes to a booked job, against a real database.
 *
 * The pure modules cover what a sheet says. Only this can prove the chain that
 * actually runs in front of an operator: real PDF bytes, through layout
 * reconstruction, through the reader, matched to a sender, stored, booked, and
 * — the part that is invisible until it goes wrong — the labels it learns from
 * what the operator had to type in by hand.
 *
 * The fixture is a generated PDF rather than a customer's. It is a real
 * Chromium-printed document with the two-column layout that these sheets have,
 * carrying no personal data, so the pdfjs path is genuinely exercised without
 * a passenger's name and mobile number living in the repository forever.
 *
 * Storage is stubbed. Vercel Blob is not reachable from a test run, and what
 * is under test here is the reading and the learning: that the bytes were
 * handed to storage at all is asserted, which is as much as a stub can
 * honestly say.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

/*
 * Fixtures are created and torn down through the raw client, which is the
 * house pattern: the extended one soft-deletes, so a `delete` here would
 * leave every row behind and the next run would collide with its own
 * leftovers — as the first run of this file did.
 */
const raw = DATABASE_AVAILABLE ? rawPrismaClient(process.env.TEST_DATABASE_URL) : null;

const uploaded: Array<{ key: string; bytes: number }> = [];

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();

  return {
    ...actual,
    upload: async (buffer: Uint8Array, key: string) => {
      uploaded.push({ key, bytes: buffer.byteLength });
      return { key, sizeBytes: buffer.byteLength };
    },
  };
});

const SHEET_PDF = DATABASE_AVAILABLE
  ? readFileSync(join(__dirname, 'job-sheets', '__fixtures__', 'keystone-55120.pdf'))
  : Buffer.alloc(0);

describe.skipIf(!DATABASE_AVAILABLE)('reading a job sheet end to end', () => {
  const stamp = String(Date.now()).slice(-7);
  const agency = `Keystone Private Hire ${stamp}`;
  /** The generated sheet's letterhead reads "KEYSTONE PRIVATE HIRE". */
  const FINGERPRINT = 'keystone private hire';

  let prisma: typeof import('./prisma').prisma;
  let store: typeof import('./job-sheets/store');
  let formValues: typeof import('./job-sheets/form-values');

  let accountId: string;
  let senderId: string;
  const sheetIds: string[] = [];
  const jobIds: string[] = [];

  beforeAll(async () => {
    if (!raw) throw new Error('no database');
    prisma = (await import('./prisma')).prisma;
    store = await import('./job-sheets/store');
    formValues = await import('./job-sheets/form-values');

    /*
     * The fingerprint has to be the agency's real letterhead for the match to
     * mean anything, so it cannot be made unique per run — and it is a unique
     * index. Clear any earlier run's row first.
     */
    await raw.sheetLabel.deleteMany({
      where: { sender: { fingerprint: FINGERPRINT } },
    });
    await raw.jobSheet.deleteMany({
      where: { sender: { fingerprint: FINGERPRINT } },
    });
    await raw.sheetSender.deleteMany({ where: { fingerprint: FINGERPRINT } });

    const account = await raw.account.create({
      data: { name: agency },
      select: { id: true },
    });
    accountId = account.id;

    const sender = await store.createSender({
      name: agency,
      fingerprint: FINGERPRINT,
      accountId,
      clientId: null,
      createdById: null,
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.sheetLabel.deleteMany({ where: { senderId } });
    await raw.jobSheet.deleteMany({ where: { id: { in: sheetIds } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.sheetSender.deleteMany({ where: { id: senderId } });
    await raw.account.deleteMany({ where: { id: accountId } });
  });

  it('reads the PDF, recognises the sender and keeps the file', async () => {
    const stored = await store.storeSheet({
      bytes: new Uint8Array(SHEET_PDF),
      fileName: 'keystone-55120.pdf',
      mimeType: 'application/pdf',
      uploadedById: null,
    });
    sheetIds.push(stored.id);

    expect(stored.sender?.id).toBe(senderId);
    expect(stored.duplicateOf).toBeNull();
    expect(stored.read.missing).toEqual([]);

    // Everything a booking needs, off a real PDF.
    expect(stored.read.draft).toMatchObject({
      scheduledDate: '2026-11-22',
      scheduledTime: '06:40',
      pickupText: 'Gatwick South Terminal, Arrivals, Crawley, RH6 0NP',
      pickupPostcode: 'RH6 0NP',
      dropoffText: 'The Langham, 1c Portland Place, London, W1B 1JA',
      passengerName: 'Nadia Fairbrother',
      passengerPhone: '07700 900915',
      passengerCount: '3',
      flightNumber: 'EZY8451',
      customerReference: 'KPH-55120',
      vehicleRequested: 'Executive Saloon',
      jobType: 'AIRPORT_TRANSFER',
    });

    // The sheet names no price, so the job will be unpriced and say so.
    expect(stored.read.draft.clientPrice).toBeNull();

    const file = uploaded.at(-1);
    expect(file?.bytes).toBe(SHEET_PDF.byteLength);
    expect(file?.key).toMatch(/^job-sheets\/sheet\//);
  });

  it('does not read the booking date as the pickup date', async () => {
    /*
     * The sheet prints `Booked On: 19 Nov 2026` in the column beside
     * `Pick-up Date: 22 Nov 2026`, on the same line. Reading rightwards from
     * the wrong label puts the car out three days early, and the form looks
     * complete either way.
     */
    const sheet = await store.getSheet(sheetIds[0]!);

    expect(sheet?.draft.scheduledDate).toBe('2026-11-22');
    expect(sheet?.sources.scheduledDate?.label).toBe('Pick-up Date:');
  });

  it('arrives at the form with the agency already billed', async () => {
    /*
     * The reason a sender is worth storing. The sheet names the passenger; it
     * cannot name which of this install's accounts gets the invoice, and a job
     * booked without one can never be billed.
     */
    const sheet = await store.getSheet(sheetIds[0]!);
    const values = formValues.sheetFormValues(sheet!.draft, sheet!.sender);

    expect(values.accountId).toBe(accountId);
    expect(values.jobType).toBe('AIRPORT_TRANSFER');
    expect(values.flightNumber).toBe('EZY8451');
    expect(values.customerReference).toBe('KPH-55120');
    // No driver and no car: those are what run the licence and MOT checks.
    expect(values).not.toHaveProperty('driverId');
    // The requested class has nowhere else to go, and it decides which car.
    expect(values.notes).toContain('Vehicle requested: Executive Saloon');
  });

  it('recognises the same file sent again', async () => {
    /*
     * Agencies resend sheets — an amended pickup, a chased confirmation, a
     * copy forwarded by somebody else. Booking the same journey twice sends
     * two cars to the same address at the same time.
     */
    const again = await store.storeSheet({
      bytes: new Uint8Array(SHEET_PDF),
      fileName: 'keystone-55120 (1).pdf',
      mimeType: 'application/pdf',
      uploadedById: null,
    });
    sheetIds.push(again.id);

    expect(again.duplicateOf?.id).toBe(sheetIds[0]);
  });

  it('learns the label behind a field the operator had to fill in', async () => {
    /*
     * The growth path, against a real sender. This sheet gives no luggage
     * count under any label the dictionary knows, so it arrives blank; the
     * operator types 2; and the label that would have produced it is recorded
     * against this agency for next time.
     *
     * Here the sheet genuinely has no luggage box, so nothing is learned —
     * which is the correct and common outcome, and is asserted because the
     * dangerous failure is learning something anyway.
     */
    const job = await raw!.job.create({
      data: {
        reference: `JS-${stamp}`,
        jobType: 'AIRPORT_TRANSFER',
        status: 'PENDING',
        scheduledAt: new Date('2113-11-22T06:40:00Z'),
        pickupText: 'Gatwick South Terminal',
        dropoffText: 'The Langham',
        accountId,
        clientPricePence: 14_500,
      },
      select: { id: true },
    });
    jobIds.push(job.id);

    await store.sheetBooked(sheetIds[0]!, job.id, {
      // Kept exactly as read.
      scheduledDate: '2026-11-22',
      scheduledTime: '06:40',
      customerReference: 'KPH-55120',
      // Typed by hand, and nowhere on the page.
      luggageCount: '2',
    });

    const sheet = await prisma.jobSheet.findUnique({
      where: { id: sheetIds[0]! },
      select: { jobId: true, status: true },
    });
    expect(sheet).toMatchObject({ jobId: job.id, status: 'BOOKED' });

    const learned = await prisma.sheetLabel.findMany({ where: { senderId } });
    expect(learned.map((row) => row.field)).not.toContain('luggageCount');
  });

  it('learns a label the page does carry', async () => {
    /*
     * The same path with something to find. This agency writes the luggage
     * count under "Bags:", which the dictionary does know — so to test the
     * learning rather than the dictionary, the field is one it does not: the
     * passenger's name under a label of this sender's own invention.
     */
    const text = [
      'KEYSTONE PRIVATE HIRE',
      'Pick-up Date:   22 Nov 2026',
      'Pick-up Time:   06:40 AM',
      'PU: Gatwick South Terminal',
      'DO: The Langham',
      'Travelling:     Nadia Fairbrother',
    ].join('\n');

    const row = await raw!.jobSheet.create({
      data: {
        fileKey: `job-sheets/sheet/learn-${stamp}/x.pdf`,
        fileName: 'learn.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        contentHash: `learn-${stamp}`,
        senderId,
        text,
        draft: { passengerName: null } as never,
        sources: {} as never,
      },
      select: { id: true },
    });
    sheetIds.push(row.id);

    await store.sheetBooked(row.id, jobIds[0]!, {
      passengerName: 'Nadia Fairbrother',
    });

    const learned = await prisma.sheetLabel.findFirst({
      where: { senderId, field: 'passengerName' },
    });

    expect(learned).toMatchObject({ label: 'Travelling:', placement: 'AFTER' });
  });

  it('uses what it learned on the next sheet', async () => {
    /*
     * The whole point, and the only test that proves the loop closes: a label
     * stored by one booking is applied by the next, so the field that had to
     * be typed once is read from then on.
     */
    const next = await store.storeSheet({
      bytes: new Uint8Array(
        Buffer.from(
          await makePdfLike([
            'KEYSTONE PRIVATE HIRE',
            'Pick-up Date:   29 Nov 2026',
            'Pick-up Time:   08:10 AM',
            'PU: Heathrow Terminal 3',
            'DO: The Savoy, Strand',
            'Travelling:     Idris Bello',
          ]),
        ),
      ),
      fileName: 'keystone-next.pdf',
      mimeType: 'application/pdf',
      uploadedById: null,
    });
    sheetIds.push(next.id);

    expect(next.read.draft.passengerName).toBe('Idris Bello');
    expect(next.read.sources.passengerName?.label).toBe('Travelling:');
  });

  /**
   * A one-page PDF carrying the given lines.
   *
   * Built here rather than committed, because what it has to exercise is the
   * learned label and not a layout — and a test that needs a new fixture file
   * for every case is a test nobody adds to.
   */
  async function makePdfLike(lines: string[]): Promise<Buffer> {
    const { default: puppeteer } = await import('puppeteer-core');

    const browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
      args: ['--no-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(
        `<pre style="font-family:Helvetica;font-size:9pt">${lines.join('\n')}</pre>`,
        { waitUntil: 'load' },
      );
      return Buffer.from(await page.pdf({ format: 'a4' }));
    } finally {
      await browser.close();
    }
  }
});

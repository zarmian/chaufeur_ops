import { describe, expect, it, vi } from 'vitest';
import { googleProvider } from './google';
import { postcodesProvider } from './postcodes';
import {
  extractPostcode,
  newSessionToken,
  preferredAddressText,
  worthAsking,
} from './types';

/**
 * Address lookup.
 *
 * Two things are worth testing here and the rest is plumbing: that a session
 * token actually reaches Google — it is the difference between a bill per
 * address and a bill per keystroke — and that the country restriction is
 * applied, because a UK operator typing "victoria" wants the station.
 *
 * The providers take an injectable `fetch`, so both are tested against
 * recorded response shapes rather than the live API.
 */

function respondWith(body: unknown, ok = true) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: ok ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('extractPostcode', () => {
  it.each([
    ['SW1A 1AA', 'SW1A 1AA'],
    ['sw1a1aa', 'SW1A 1AA'],
    ['The Dorchester, Park Lane, London W1K 1QA, UK', 'W1K 1QA'],
    ['Heathrow Terminal 5, Longford TW6 2GA', 'TW6 2GA'],
  ])('finds %s', (input, expected) => {
    expect(extractPostcode(input)).toBe(expected);
  });

  it('finds nothing in text with no postcode', () => {
    expect(extractPostcode('The Dorchester')).toBeNull();
    expect(extractPostcode('')).toBeNull();
  });
});

describe('worthAsking', () => {
  it('refuses a query too short to mean anything', () => {
    // Two characters match half of London and cost the same as a good query.
    expect(worthAsking('th')).toBe(false);
    expect(worthAsking('  a ')).toBe(false);
    expect(worthAsking('dorchester')).toBe(true);
  });
});

describe('newSessionToken', () => {
  it('is different every time', () => {
    expect(newSessionToken()).not.toBe(newSessionToken());
  });
});

describe('googleProvider', () => {
  const suggestionBody = {
    suggestions: [
      {
        placePrediction: {
          placeId: 'place-1',
          text: { text: 'The Dorchester, Park Lane, London' },
          structuredFormat: {
            mainText: { text: 'The Dorchester' },
            secondaryText: { text: 'Park Lane, London' },
          },
        },
      },
    ],
  };

  it('sends the session token, which is what makes this affordable', async () => {
    const fetchImpl = respondWith(suggestionBody);
    const provider = googleProvider({ apiKey: 'k', fetchImpl });

    await provider.suggest('dorchester', { sessionToken: 'session-1' });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.sessionToken).toBe('session-1');
  });

  it('restricts to the configured country', async () => {
    const fetchImpl = respondWith(suggestionBody);
    const provider = googleProvider({ apiKey: 'k', country: 'GB', fetchImpl });

    await provider.suggest('victoria', {});

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.includedRegionCodes).toEqual(['gb']);
  });

  it('keeps the key in the header, never the URL', async () => {
    // A key in a query string ends up in every proxy log between here and
    // Google.
    const fetchImpl = respondWith(suggestionBody);
    const provider = googleProvider({ apiKey: 'secret-key', fetchImpl });

    await provider.suggest('dorchester', {});

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(url)).not.toContain('secret-key');
    expect((init as RequestInit).headers).toMatchObject({
      'X-Goog-Api-Key': 'secret-key',
    });
  });

  it('reads the structured suggestion', async () => {
    const provider = googleProvider({
      apiKey: 'k',
      fetchImpl: respondWith(suggestionBody),
    });

    const [first] = await provider.suggest('dorchester', {});
    expect(first?.primary).toBe('The Dorchester');
    expect(first?.secondary).toBe('Park Lane, London');
    expect(first?.id).toBe('place-1');
  });

  it('skips a prediction with no place id, which cannot be resolved', async () => {
    const provider = googleProvider({
      apiKey: 'k',
      fetchImpl: respondWith({ suggestions: [{ placePrediction: {} }] }),
    });
    expect(await provider.suggest('x', {})).toEqual([]);
  });

  it('takes the postcode from the address component', async () => {
    const provider = googleProvider({
      apiKey: 'k',
      fetchImpl: respondWith({
        id: 'place-1',
        displayName: { text: 'The Dorchester' },
        formattedAddress: '53 Park Ln, London W1K 1QA, UK',
        location: { latitude: 51.5074, longitude: -0.1523 },
        addressComponents: [
          { longText: 'W1K 1QA', types: ['postal_code'] },
          { longText: 'London', types: ['postal_town'] },
        ],
      }),
    });

    const detail = await provider.detail('place-1', {});
    expect(detail?.postcode).toBe('W1K 1QA');
    expect(detail?.label).toBe('The Dorchester');
    expect(detail?.lat).toBeCloseTo(51.5074);
  });

  it('falls back to the postcode in the formatted address', async () => {
    // A handful of places carry no `postal_code` component, and the postcode
    // is what prices the job.
    const provider = googleProvider({
      apiKey: 'k',
      fetchImpl: respondWith({
        displayName: { text: 'Heathrow Terminal 5' },
        formattedAddress: 'Longford, Hounslow TW6 2GA, UK',
        location: { latitude: 51.47, longitude: -0.49 },
      }),
    });

    expect((await provider.detail('p', {}))?.postcode).toBe('TW6 2GA');
  });

  it('reports Google’s own message, because the fixes differ', async () => {
    // A billing failure and a bad key need different actions, and "lookup
    // failed" sends the operator to neither.
    const provider = googleProvider({
      apiKey: 'k',
      fetchImpl: respondWith(
        {
          error: {
            message: 'This API project is not authorized',
            status: 'PERMISSION_DENIED',
          },
        },
        false,
      ),
    });

    await expect(provider.suggest('x', {})).rejects.toThrow('not authorized');
  });
});

describe('postcodesProvider', () => {
  it('completes a partial postcode', async () => {
    const provider = postcodesProvider({
      fetchImpl: respondWith({ result: ['SW1A 1AA', 'SW1A 2AA'] }),
    });

    const suggestions = await provider.suggest('SW1A', {});
    expect(suggestions.map((s) => s.primary)).toEqual(['SW1A 1AA', 'SW1A 2AA']);
    expect(suggestions[0]?.source).toBe('postcodes');
  });

  it('pulls the postcode out of a longer line before asking', async () => {
    const fetchImpl = respondWith({ result: ['W1K 1QA'] });
    const provider = postcodesProvider({ fetchImpl });

    await provider.suggest('53 Park Lane W1K 1QA', {});

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(String(url)).toContain('W1K%201QA');
  });

  it('returns nothing rather than throwing when the service is down', async () => {
    // The fallback failing must not empty a booking form.
    const provider = postcodesProvider({ fetchImpl: respondWith({}, false) });
    expect(await provider.suggest('SW1A', {})).toEqual([]);
    expect(await provider.detail('SW1A 1AA', {})).toBeNull();
  });

  it('builds an address from what a postcode lookup can honestly give', async () => {
    const provider = postcodesProvider({
      fetchImpl: respondWith({
        result: {
          postcode: 'W1K 1QA',
          latitude: 51.5074,
          longitude: -0.1523,
          admin_ward: 'West End',
          admin_district: 'Westminster',
          region: 'London',
        },
      }),
    });

    const detail = await provider.detail('W1K 1QA', {});
    expect(detail?.address).toBe('West End, Westminster, London, W1K 1QA');
    expect(detail?.postcode).toBe('W1K 1QA');
    expect(detail?.lat).toBeCloseTo(51.5074);

    // The label is what reaches the pickup box and the driver's job card, so
    // it is the area rather than the bare code. A driver cannot navigate by
    // "W1K 1QA" without typing it into something else first.
    expect(detail?.label).toBe('West End, Westminster, London, W1K 1QA');
  });

  it('does not repeat a district that is also the region', async () => {
    const provider = postcodesProvider({
      fetchImpl: respondWith({
        result: {
          postcode: 'M1 1AE',
          admin_ward: 'Piccadilly',
          admin_district: 'Manchester',
          region: 'Manchester',
        },
      }),
    });

    expect((await provider.detail('M1 1AE', {}))?.address).toBe(
      'Piccadilly, Manchester, M1 1AE',
    );
  });
});

/**
 * The rule that stopped a pasted address becoming a postcode.
 *
 * Choosing a suggestion used to overwrite the box with the provider's label,
 * whatever it was. On the default postcode provider that label was the bare
 * code, so an operator who pasted a full street address and picked the
 * matching postcode watched the building, the street and the number vanish —
 * and vanish from the driver's job card with it, since `pickupText` is what
 * the driver is sent.
 */
describe('preferredAddressText', () => {
  it('keeps a pasted address when the lookup only knows the postcode', () => {
    // The report, exactly.
    expect(
      preferredAddressText('10 Downing Street, London SW1A 2AA', 'SW1A 2AA'),
    ).toBe('10 Downing Street, London SW1A 2AA');
  });

  it('keeps the typed address even when the label is longer but different', () => {
    // The postcode provider's richer label still does not know the building.
    expect(
      preferredAddressText(
        'Flat 4, 22 Mount Street, W1K 1QA',
        'West End, Westminster, London, W1K 1QA',
      ),
    ).toBe('Flat 4, 22 Mount Street, W1K 1QA');
  });

  it('takes the label when it contains everything that was typed', () => {
    // The case the overwrite was written for, and it still works.
    expect(preferredAddressText('dorchester', 'The Dorchester')).toBe(
      'The Dorchester',
    );
    expect(preferredAddressText('heathrow t', 'Heathrow Terminal 5')).toBe(
      'Heathrow Terminal 5',
    );
  });

  it('upgrades a bare postcode to the area the lookup names', () => {
    expect(
      preferredAddressText('w1k1qa', 'West End, Westminster, London, W1K 1QA'),
    ).toBe('West End, Westminster, London, W1K 1QA');
  });

  it('ignores spacing, case and punctuation when comparing', () => {
    // Two spellings of one postcode must not read as two different places.
    expect(preferredAddressText('sw1a 2aa', 'SW1A 2AA')).toBe('SW1A 2AA');
    expect(preferredAddressText('THE  DORCHESTER', 'The Dorchester')).toBe(
      'The Dorchester',
    );
  });

  it('takes the label when nothing was typed', () => {
    // Picking from the saved list without typing.
    expect(preferredAddressText('', 'The Dorchester')).toBe('The Dorchester');
    expect(preferredAddressText('   ', 'The Dorchester')).toBe(
      'The Dorchester',
    );
  });

  it('keeps what was typed when the lookup has no label at all', () => {
    expect(preferredAddressText('The Dorchester', '')).toBe('The Dorchester');
  });
});

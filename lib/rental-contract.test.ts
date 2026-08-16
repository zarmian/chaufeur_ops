import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from './branding';
import { DEFAULT_LOCALE_CONFIG } from './locale';
import { renderRentalContract, type ContractData } from './rental-contract';
import { renterDetails, renterName } from './rentals';

/**
 * The hire agreement.
 *
 * Two things are worth pinning. A charge nobody set must not print as zero —
 * "£0.00 excess" is a contract saying the hirer owes nothing, which is the
 * opposite of a blank. And the document must carry no operator's name of its
 * own: this is a white-label product, and a contract with WeLux baked into it
 * would go out under the next customer's logo.
 */

function contract(overrides: Partial<ContractData> = {}): ContractData {
  return {
    reference: 'RNT-000042',
    issuedOn: '14 August 2026',
    startAt: '28 July 2026, 20:00',
    endAt: '2 August 2026, 11:00',
    hirer: {
      name: 'Mr James Campbell',
      address: 'Flat 7, Rowlock House, West Drayton, UB7 7FX',
      phone: '+44 7446 833511',
      licenceNumber: 'CAMPB902214JA9LJ',
    },
    vehicle: {
      registration: 'LC24 YNH',
      makeModel: 'Land Rover Range Rover Autobiography',
      chassisNumber: 'SAL1234567890',
      firstRegisteredOn: '8 July 2026',
      valuePence: 14_300_000,
      insurerName: 'Tradex',
      policyNumber: 'P-TFL00294855/05',
      mileageOut: 1270,
    },
    terms: {
      termDays: 5,
      minimumTermDays: 4,
      ratePence: 18_000,
      rateUnit: 'day',
      advanceRentals: 4.5,
      advancePaymentPence: 40_000,
      depositPence: 100_000,
      depositReturnDays: 10,
      mileageAllowancePerDay: 175,
      excessMileagePence: 150,
      insuranceExcessPence: 250_000,
      congestionChargePence: 1500,
      smokingChargePence: 30_000,
      panelRepairPence: 15_000,
      wheelScratchPence: 10_000,
    },
    ownerSignatory: 'Waleed Ahmed, Director',
    ...overrides,
  };
}

const render = (data: ContractData) =>
  renderRentalContract(data, { branding: DEFAULT_BRANDING, locale: DEFAULT_LOCALE_CONFIG });

describe('renderRentalContract', () => {
  it('contains all three documents in one file', () => {
    const html = render(contract());
    expect(html).toContain('Contract hire agreement');
    expect(html).toContain('Confirmation and acceptance of vehicle liability');
    expect(html).toContain('Terms and conditions');
    // Two breaks, so each part begins on its own sheet when printed. Counted
    // by the attribute, not the class name — the stylesheet mentions it too.
    expect(html.match(/class="page-break"/g)?.length).toBe(2);
  });

  it('prints the money the operator set, in pounds', () => {
    const html = render(contract());
    expect(html).toContain('£2,500.00'); // insurance excess
    expect(html).toContain('£1.50'); // excess mileage, per mile
    expect(html).toContain('£15.00'); // congestion, per day
    expect(html).toContain('£143,000.00'); // vehicle value
    expect(html).toContain('175 miles');
  });

  it('leaves a line to write on rather than printing zero', () => {
    // The failure this guards: an unset excess rendered as "£0.00" is a
    // contract stating the hirer owes nothing in the event of a claim.
    const html = render(
      contract({
        terms: {
          ...contract().terms,
          insuranceExcessPence: null,
          excessMileagePence: null,
          mileageAllowancePerDay: null,
          minimumTermDays: null,
          depositReturnDays: null,
        },
      }),
    );
    expect(html).not.toContain('£0.00');
    expect(html).toContain('class="rule"');
  });

  it('names no operator of its own', () => {
    // White label: the only company named is whatever branding says.
    const html = render(contract());
    expect(html).not.toMatch(/welux/i);
    expect(html).toContain(DEFAULT_BRANDING.tradingName);
  });

  it('gives both parties somewhere to sign, on every part', () => {
    const html = render(contract());
    // Three documents, two signatures each.
    expect(html.match(/class="cap">Signature/g)?.length).toBe(6);
  });

  it('escapes a hirer name that contains markup', () => {
    const html = render(
      contract({
        hirer: { ...contract().hirer, name: '<script>alert(1)</script>' },
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('who the renter is', () => {
  it('names a driver, a company or a one-off hirer', () => {
    expect(
      renterName({ renterType: 'DRIVER', driver: { name: 'Sam Okafor' } }),
    ).toBe('Sam Okafor');
    expect(
      renterName({ renterType: 'ACCOUNT', account: { name: 'SUL Business Academy' } }),
    ).toBe('SUL Business Academy');
    expect(
      renterName({ renterType: 'EXTERNAL', hirerName: 'Mr James Campbell' }),
    ).toBe('Mr James Campbell');
  });

  it('takes a company hire’s address from the account', () => {
    const details = renterDetails({
      renterType: 'ACCOUNT',
      account: {
        name: 'SUL Business Academy',
        contactPhone: '020 7946 0000',
        billingAddress: '1 Example Street, London',
      },
      // The licence belongs to whoever actually drives it, so it is recorded
      // per hire even when the hirer is a company.
      hirerLicenceNumber: 'SMITH901234AB9CD',
    });
    expect(details.name).toBe('SUL Business Academy');
    expect(details.address).toBe('1 Example Street, London');
    expect(details.licenceNumber).toBe('SMITH901234AB9CD');
  });

  it('falls back to the hire’s own details when an account has no address', () => {
    const details = renterDetails({
      renterType: 'ACCOUNT',
      account: { name: 'Montclares', contactPhone: null, billingAddress: null },
      hirerAddress: '27 Spearing Road, High Wycombe',
      hirerPhone: '+44 7700 900123',
    });
    expect(details.address).toBe('27 Spearing Road, High Wycombe');
    expect(details.phone).toBe('+44 7700 900123');
  });

  it('says so plainly when a renter has no name', () => {
    // Better on a contract than an empty line that reads as an oversight.
    expect(renterName({ renterType: 'EXTERNAL', hirerName: '   ' })).toBe('Unnamed hirer');
    expect(renterName({ renterType: 'DRIVER', driver: null })).toBe('Unknown driver');
  });
});

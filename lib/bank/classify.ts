/**
 * Deciding what a statement line is.
 *
 * A phrase and a classification, nothing cleverer. Anything the rules do not
 * recognise stays `UNCLASSIFIED` and visible — it is never guessed into a
 * category to make the list look finished, because a wrong classification
 * that nobody notices is worse than an obvious gap somebody fixes.
 *
 * Pure, so the matching order can be tested without a database.
 */

export type BankTxnKind =
  | 'CLIENT_PAYMENT'
  | 'DRIVER_PAYOUT'
  | 'FUEL'
  | 'VEHICLE_COST'
  | 'RENTAL_INCOME'
  | 'TRANSFER'
  | 'UNCLASSIFIED';

export const TXN_KINDS: Array<{ value: BankTxnKind; label: string }> = [
  { value: 'CLIENT_PAYMENT', label: 'Client payment' },
  { value: 'DRIVER_PAYOUT', label: 'Driver payout' },
  { value: 'FUEL', label: 'Fuel' },
  { value: 'VEHICLE_COST', label: 'Vehicle cost' },
  { value: 'RENTAL_INCOME', label: 'Hire income' },
  { value: 'TRANSFER', label: 'Own transfer' },
  { value: 'UNCLASSIFIED', label: 'Unclassified' },
];

export interface ClassifyRule {
  id: string;
  phrase: string;
  kind: BankTxnKind;
  priority: number;
  active: boolean;
  clientId?: string | null;
  accountId?: string | null;
  driverId?: string | null;
  vehicleId?: string | null;
}

export interface Classification {
  kind: BankTxnKind;
  ruleId: string | null;
  clientId: string | null;
  accountId: string | null;
  driverId: string | null;
  vehicleId: string | null;
  /** Shown next to the row, so a wrong rule can be found and edited. */
  why: string;
}

/**
 * Normalised for matching.
 *
 * Bank descriptions arrive in shouting caps with runs of spaces and card
 * terminal noise. Lower-cased and collapsed so a rule for `shell` matches
 * `SHELL   FILLING STN  4412`.
 */
export function normaliseDescription(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Classify one transaction.
 *
 * The longest matching phrase wins, then priority, then the rule id — so the
 * same description always classifies the same way. A rule for
 * `shell recharge` beats one for `shell`, which is the point of preferring
 * length: the more specific claim is the more considered one.
 *
 * The direction is used only as a sanity check, and only to *reject* a rule
 * that contradicts it. A rule saying `CLIENT_PAYMENT` cannot apply to money
 * leaving the account, however well its phrase matched.
 */
export function classify(
  transaction: { description: string; amountPence: number },
  rules: ClassifyRule[],
): Classification {
  const haystack = normaliseDescription(transaction.description);
  const incoming = transaction.amountPence > 0;

  const matching = rules
    .filter((rule) => rule.active && rule.phrase.trim() !== '')
    .filter((rule) => haystack.includes(normaliseDescription(rule.phrase)))
    .filter((rule) => directionAllows(rule.kind, incoming))
    .sort(
      (a, b) =>
        b.phrase.length - a.phrase.length ||
        b.priority - a.priority ||
        a.id.localeCompare(b.id),
    );

  const winner = matching[0];

  if (!winner) {
    return {
      kind: 'UNCLASSIFIED',
      ruleId: null,
      clientId: null,
      accountId: null,
      driverId: null,
      vehicleId: null,
      why: 'No rule matched this description',
    };
  }

  return {
    kind: winner.kind,
    ruleId: winner.id,
    clientId: winner.clientId ?? null,
    accountId: winner.accountId ?? null,
    driverId: winner.driverId ?? null,
    vehicleId: winner.vehicleId ?? null,
    why: `Matched “${winner.phrase}”`,
  };
}

/**
 * Whether a classification can apply in this direction.
 *
 * Money in is never a payout or a fuel bill; money out is never a client
 * payment or hire income. A transfer goes both ways, and so does an
 * unclassified line.
 */
export function directionAllows(kind: BankTxnKind, incoming: boolean): boolean {
  switch (kind) {
    case 'CLIENT_PAYMENT':
    case 'RENTAL_INCOME':
      return incoming;
    case 'DRIVER_PAYOUT':
    case 'FUEL':
    case 'VEHICLE_COST':
      return !incoming;
    default:
      return true;
  }
}

/**
 * Attribute an incoming payment to a client or account by name.
 *
 * Bank references carry the payer's name, sometimes truncated and usually
 * without punctuation — `HALDEN AND CO LTD` for `Halden & Co`. Matched on a
 * stripped form of the name, and only when exactly one candidate matches:
 * two clients called Smith would otherwise have each other's money.
 *
 * A short name is refused entirely. `A1 Cars` reduced to `a1cars` is fine,
 * but a two-character name would match half the statement.
 */
export interface Payer {
  id: string;
  name: string;
  kind: 'client' | 'account';
}

export type PayerMatch =
  | { kind: 'one'; payer: Payer }
  | { kind: 'several'; candidates: Payer[] }
  | { kind: 'none' };

const MIN_NAME_LENGTH = 4;

export function matchPayer(description: string, payers: Payer[]): PayerMatch {
  const haystack = stripForMatching(description);

  const candidates = payers.filter((payer) => {
    const needle = stripForMatching(payer.name);
    return needle.length >= MIN_NAME_LENGTH && haystack.includes(needle);
  });

  if (candidates.length === 1) return { kind: 'one', payer: candidates[0]! };
  if (candidates.length > 1) {
    // The longest name wins only when it *contains* the others — "Halden"
    // and "Halden & Co" are the same payer written twice. Genuinely distinct
    // names stay ambiguous.
    const sorted = [...candidates].sort(
      (a, b) => stripForMatching(b.name).length - stripForMatching(a.name).length,
    );
    const longest = stripForMatching(sorted[0]!.name);
    const nested = sorted.every((payer) =>
      longest.includes(stripForMatching(payer.name)),
    );
    return nested
      ? { kind: 'one', payer: sorted[0]! }
      : { kind: 'several', candidates };
  }

  return { kind: 'none' };
}

/** Letters and digits only, lower-cased. `Halden & Co.` becomes `haldenco`. */
export function stripForMatching(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The rules a fresh install starts with.
 *
 * A starting point the operator edits, not a claim to completeness. Fuel and
 * road charges only, because those are the ones every UK operator has and
 * nobody wants to type.
 */
export const SEED_RULES: Array<{
  phrase: string;
  kind: BankTxnKind;
  priority: number;
}> = [
  { phrase: 'shell', kind: 'FUEL', priority: 0 },
  { phrase: 'bp ', kind: 'FUEL', priority: 0 },
  { phrase: 'esso', kind: 'FUEL', priority: 0 },
  { phrase: 'texaco', kind: 'FUEL', priority: 0 },
  { phrase: 'applegreen', kind: 'FUEL', priority: 0 },
  { phrase: 'moto ', kind: 'FUEL', priority: 0 },
  { phrase: 'tfl ', kind: 'VEHICLE_COST', priority: 0 },
  { phrase: 'congestion', kind: 'VEHICLE_COST', priority: 0 },
  { phrase: 'ulez', kind: 'VEHICLE_COST', priority: 0 },
  { phrase: 'dart charge', kind: 'VEHICLE_COST', priority: 0 },
  { phrase: 'dvla', kind: 'VEHICLE_COST', priority: 0 },
  { phrase: 'kwik fit', kind: 'VEHICLE_COST', priority: 0 },
  { phrase: 'halfords', kind: 'VEHICLE_COST', priority: 0 },
];

/**
 * How many past transactions a proposed rule would also have caught.
 *
 * Shown when an operator classifies something by hand and is offered a rule:
 * "this would also have caught 34 others" is the difference between a useful
 * rule and one that reclassifies half the statement.
 */
export function wouldAlsoMatch(
  phrase: string,
  transactions: Array<{ description: string; amountPence: number }>,
  kind: BankTxnKind,
): number {
  const needle = normaliseDescription(phrase);
  if (needle === '') return 0;

  return transactions.filter(
    (txn) =>
      normaliseDescription(txn.description).includes(needle) &&
      directionAllows(kind, txn.amountPence > 0),
  ).length;
}

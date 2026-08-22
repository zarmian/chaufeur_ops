/**
 * The board a driver holds up in the arrivals hall.
 *
 * One job, one name, as large as the sheet or the screen will carry it. That
 * is the whole product: a passenger coming through the doors at Terminal 5
 * scans a row of held-up boards for their own name, and anything else on the
 * board is something their eye has to discard first.
 *
 * The operator asked for nothing but the name, and this takes that literally
 * — no logo, no flight number, no reference. Some clients specifically do not
 * want their guests met by a board advertising a supplier, and a name that
 * fills the sheet is readable from further away than one sharing it.
 *
 * Screen and paper come out of the same function, so the thing the driver
 * looks at on their phone and the thing the office prints cannot drift apart.
 */

/** Nothing narrower than this is worth a board. */
export interface BoardJob {
  jobType: string;
  passengerName: string | null;
}

/**
 * Whether this job can have a board.
 *
 * Airport transfers only, by decision — meeting somebody at arrivals is the
 * case that needs it. A name is equally required: a board is the name, so
 * there is nothing to print without one, and offering the button anyway
 * produces a blank sheet somebody has to work out how to fix.
 */
export function canHaveNameBoard(job: BoardJob): boolean {
  return job.jobType === 'AIRPORT_TRANSFER' && normaliseName(job.passengerName) !== '';
}

/** Collapsed whitespace, trimmed. What is actually shown. */
export function normaliseName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * How wide a character is, as a fraction of its height.
 *
 * A bold sans capital is a bit under two-thirds as wide as it is tall. The
 * scripts below are not: CJK ideographs, kana, Hangul and the full-width
 * forms are drawn on a square body, so a four-character Japanese name is more
 * than twice as wide as four Latin letters at the same size.
 *
 * Discovered by rendering one. `田中さん` at the size that comfortably fits
 * "Mr Ali" wrapped to two lines and ran off the bottom of a phone held
 * sideways — a board that is unreadable in exactly the case it is most needed,
 * because a driver meeting a Japanese passenger is the one who can least
 * afford to be holding up a name nobody can read.
 */
function characterWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;

  const wide =
    // CJK ideographs, and the radicals and strokes with them
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) || // kana, Hangul jamo, CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // full-width forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd); // CJK extensions B onwards

  return wide ? 1 : 0.62;
}

/** A word's width at font-size 1, in multiples of the font size. */
export function widthUnits(text: string): number {
  return [...text].reduce((total, char) => total + characterWidth(char), 0);
}

/**
 * How big the name can be set, as a proportion of the board's width.
 *
 * A fixed size is wrong at one end or the other: "Li" set to fit
 * "Wolfeschlegelsteinhausenberger" is a word lost in a white sheet, and the
 * reverse runs off the edge.
 *
 * Expressed in `cqw` — percent of the board's own width — so one number
 * serves a phone held sideways and a sheet of A4 without either being asked
 * about.
 */
export function nameScale(name: string): number {
  const tidy = normaliseName(name);
  const words = tidy.split(' ').filter(Boolean);
  if (words.length === 0) return 0;

  const longest = Math.max(...words.map(widthUnits));
  const whole = widthUnits(tidy);

  /*
   * Two limits, and the smaller wins.
   *
   * **Width.** The longest single word has to fit on one line, because a word
   * is what cannot be broken. The measure is the longest *word* and not the
   * whole string for exactly that reason: "Mr Christopher Featherstonehaugh"
   * is three comfortable lines, not one impossible one. 92 rather than 100,
   * to leave the board its margins.
   */
  const byWidth = 92 / longest;

  /*
   * **Height.** The one a Latin-only reading misses.
   *
   * A board is much wider than it is tall — a phone held sideways gives about
   * 42cqw of height — so a name that needs several lines runs off the bottom
   * long before it runs off the sides. Lines needed at a given size are
   * roughly `whole × scale / 100`, and each is 1.05 of the size, which
   * rearranges to the square root below.
   */
  const byHeight = Math.sqrt(3600 / whole);

  // Never past 26cqw — a two-letter name set to fill the width reads as a
  // logo rather than as a name, and the board stops looking like a board.
  return Math.max(4, Math.min(26, byWidth, byHeight));
}

export type BoardVariant = 'screen' | 'print';

/**
 * The board, as a complete HTML document.
 *
 * Returned as a string rather than as React because both consumers want a
 * document rather than a component: the route handler serves it with no app
 * shell around it, and Chromium renders it to a PDF where nothing of the
 * application exists at all. A React page would inherit the dashboard's
 * stylesheet, its theme and its chrome, none of which belong on a sheet of
 * paper held above somebody's head.
 *
 * Colour literals are fine here and nowhere else in the interface: this
 * document is not part of the themed application, it has no access to the
 * brand custom properties, and a name board is black and white by function.
 * The lint rule that forbids them covers `app/` and `components/`.
 */
export function nameBoardDocument(
  names: string[],
  variant: BoardVariant = 'screen',
): string {
  /*
   * White on black for a screen, black on white for paper.
   *
   * Not a preference. A phone at arrivals-hall brightness is far more legible
   * as light-on-dark, and it costs less battery on the OLED panel in every
   * modern handset — which matters when the board has been held up for the
   * twenty minutes since the flight landed. On paper the same choice would be
   * a solid sheet of toner.
   */
  const ink = variant === 'print' ? '#000000' : '#ffffff';
  const ground = variant === 'print' ? '#ffffff' : '#000000';

  const boards = names
    .map((raw) => {
      const name = normaliseName(raw);
      return `<section class="board" style="--scale:${nameScale(name).toFixed(2)}cqw"><h1>${escapeHtml(name)}</h1></section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Name board</title>
<style>
  @page { size: A4 landscape; margin: 0; }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    background: ${ground};
    color: ${ink};
    /* The platform's own face. It ships the legibility tuning a name board
       depends on, and a webfont that fails to load in an arrivals hall with
       no signal would leave the driver holding a blank rectangle. */
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .board {
    /* Container queries, so the type is sized against the board and not the
       window. On paper there is no window to size against at all. */
    container-type: inline-size;
    width: 100%;
    /* Small viewport units: on a phone, "vh" is the height *without* the
       browser's chrome, so a board measured in "vh" is cut off by the address
       bar until the user scrolls — which they will not do while holding it
       above their head. */
    height: 100svh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4svh 4vw;
    text-align: center;
    /* One board per sheet when several are printed together. */
    break-after: page;
  }

  .board:last-child { break-after: auto; }

  h1 {
    font-size: var(--scale);
    line-height: 1.05;
    font-weight: 700;
    /* Tightened, because at this size the default spacing reads as gappy —
       the tracking rule that applies to every heading, at the extreme. */
    letter-spacing: -0.02em;
    /* A long name breaks between words rather than running off the edge, and
       a single unbreakable word is broken rather than lost. */
    overflow-wrap: anywhere;
    text-wrap: balance;
  }

  @media print {
    html, body { background: #ffffff; color: #000000; }
    .board { height: 100vh; }
  }
</style>
</head>
<body>
${boards}
<script>
/*
 * Keep the screen awake.
 *
 * A phone held up at arrivals dims and locks while the driver waits, and a
 * board that has gone black is worse than no board — they are holding it up
 * believing it works. Best-effort and wrapped: the API is unavailable on
 * some browsers and refuses outside a user gesture on others, and a board
 * that throws is a board that does not render.
 */
(function () {
  var lock = null;
  function hold() {
    try {
      if (!('wakeLock' in navigator)) return;
      navigator.wakeLock.request('screen').then(function (result) {
        lock = result;
      }, function () {});
    } catch (_) {}
  }
  hold();
  // Re-taken when the driver comes back to the tab: a lock is released the
  // moment the page is hidden and is not restored on its own.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && lock === null) hold();
  });
  document.addEventListener('click', hold, { once: true });
})();
</script>
</body>
</html>`;
}

/** The five characters that would otherwise let a name close a tag. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Where a job's board lives, relative to the application. */
export function nameBoardPath(token: string): string {
  return `/board/${token}`;
}

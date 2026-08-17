/**
 * Light, dark, or whatever the machine says.
 *
 * A client-safe leaf: imports nothing, so both the Server Component that
 * reads the cookie and the Client Component that writes it can share these
 * without dragging server modules into the browser bundle. Same reasoning as
 * `lib/enum-options.ts`.
 *
 * Why this exists at all: `app/globals.css` has carried a complete `.dark`
 * token set since the beginning, and `lib/theme.ts` has been emitting a
 * `.dark{…}` block of brand colours alongside the light one — but nothing
 * anywhere applied the class, so none of it was reachable. Meanwhile
 * `viewport.colorScheme` is declared `'light dark'`, which tells the browser
 * to render its own controls in the user's scheme. On a machine set to dark
 * that produced the worst of both: dark scrollbars, dark date pickers and
 * dark native selects on a permanently light page.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * A cookie rather than `localStorage`.
 *
 * The server has to know the answer while it renders, or the page paints in
 * one theme and corrects itself in the next frame — the flash of the wrong
 * theme that every dark mode implementation is judged by. `localStorage` is
 * unreadable from the server; a cookie arrives with the request.
 */
export const THEME_COOKIE = 'theme';

/** A year. The preference is not a session decision. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const THEME_PREFERENCES: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Anything unrecognised means nobody has chosen, which means follow the OS. */
export function parseThemePreference(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * The class the server can be sure about.
 *
 * Only an explicit choice resolves here. `system` returns null because the
 * server cannot see `prefers-color-scheme` — that one is settled before paint
 * by the script below.
 */
export function themeClassFor(preference: ThemePreference): string | null {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return null;
  return null;
}

/**
 * The blocking script that settles `system` before the first paint.
 *
 * It runs synchronously in `<head>`, so the class is on `<html>` before any
 * pixels exist and there is nothing to flash. Deliberately tiny and wrapped
 * in a try/catch: a script that throws here would leave the page unstyled
 * rather than merely in the wrong theme.
 *
 * Contains no interpolation — it reads the preference from the `data-theme`
 * attribute the server already rendered, so there is no user-controlled text
 * anywhere in it.
 */
export const THEME_SCRIPT = `(function(){try{var e=document.documentElement;if(e.dataset.theme!=="system")return;if(window.matchMedia("(prefers-color-scheme: dark)").matches)e.classList.add("dark")}catch(_){}})()`;

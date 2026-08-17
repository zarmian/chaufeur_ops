'use client';

import { Check, ChevronDown, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';
import { applyTheme } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  THEME_PREFERENCES,
  type ThemePreference,
} from '@/lib/theme-preference';
import { cn } from '@/lib/utils';

const THEME_ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function UserMenu({
  name,
  email,
  role,
  themePreference,
  setThemeAction,
  signOutAction,
}: {
  name: string;
  email: string;
  role: string;
  themePreference: ThemePreference;
  setThemeAction: (preference: ThemePreference) => Promise<void>;
  signOutAction: () => Promise<void>;
}) {
  /*
   * Held locally as well as in the cookie so the tick moves on the click.
   *
   * The cookie is the durable answer, but waiting for the Server Action to
   * return before showing which option is now selected would leave the menu
   * showing the old one for the length of a round trip.
   */
  const [theme, setTheme] = React.useState(themePreference);

  function chooseTheme(next: ThemePreference) {
    setTheme(next);
    applyTheme(next);
    // Fire and forget: the theme is already on the page, and this only has to
    // land before the next full page load.
    void setThemeAction(next);
  }

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
            {initials || '?'}
          </span>
          <span className="hidden text-sm font-medium sm:inline">{name}</span>
          <Badge variant="outline" className="hidden md:inline-flex">
            {role}
          </Badge>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-normal">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        {THEME_PREFERENCES.map(({ value, label }) => {
          const Icon = THEME_ICONS[value];
          const selected = theme === value;
          return (
            <DropdownMenuItem
              key={value}
              // `onSelect` rather than `onClick`: it is the one Radix also
              // fires for Enter and Space, so the menu works from the
              // keyboard without a second handler.
              onSelect={() => chooseTheme(value)}
              className="cursor-pointer"
            >
              <Icon className="size-4" aria-hidden />
              <span className="flex-1">{label}</span>
              {/* Reserved whether or not it is showing, so choosing an option
                  does not shuffle the other two sideways. */}
              <Check
                className={cn('size-4', selected ? 'opacity-100' : 'opacity-0')}
                aria-hidden
              />
              {selected ? <span className="sr-only">(selected)</span> : null}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        {/* The form wraps the item so the menu item *is* the submit button —
            with the form inside, `asChild` would put role="menuitem" on the
            form and a click would never submit. */}
        <form action={signOutAction}>
          <DropdownMenuItem asChild>
            <button
              type="submit"
              className="flex w-full cursor-pointer items-center gap-2 text-left"
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

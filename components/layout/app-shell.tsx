'use client';

import { Menu, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose } from '@/components/ui/sheet';
import type { NavSection } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { SidebarNav } from './sidebar-nav';

/**
 * Two-column shell: a permanent sidebar from `lg` up, and a drawer beneath
 * it. The ops team works on laptops, so the desktop layout is the one that
 * matters — tablet is the floor, phones are out of scope.
 *
 * The drawer used to be `{open ? <aside/> : null}`, which gave it no exit
 * animation and nothing to grab. It is a `Sheet` now: it slides in from the
 * left, leaves the same way, and can be dragged or thrown closed. See
 * `components/ui/sheet.tsx` for why that matters.
 *
 * The permanent sidebar stays opaque on purpose. Translucency is how you show
 * that content continues underneath a floating layer — and nothing passes
 * under the permanent sidebar, because the page is inset by its width. A blur
 * there would be an effect rather than information, and one that costs a
 * full-height composite on every scroll.
 */
export function AppShell({
  sections,
  brand,
  header,
  children,
}: {
  sections: NavSection[];
  brand: React.ReactNode;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const scrolled = useScrolled();

  /*
   * Resizing past the breakpoint closes the drawer.
   *
   * Without this, a drawer opened on a tablet stays mounted when the window
   * grows — hidden behind the permanent sidebar, but still holding the focus
   * trap, so keyboard focus is stuck inside something nobody can see.
   */
  React.useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const sync = () => {
      if (wide.matches) setOpen(false);
    };
    sync();
    wide.addEventListener('change', sync);
    return () => wide.removeEventListener('change', sync);
  }, []);

  return (
    <div className="min-h-screen">
      {/*
        Every page puts the whole navigation before its content in the tab
        order. Without this, reaching the first control on a job costs a
        dispatcher thirty-odd tab presses, on every page, all day.
      */}
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {/* Permanent sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-card lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          {brand}
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav sections={sections} instanceId="sidebar" />
        </div>
      </aside>

      {/* Drawer, for anything narrower */}
      <Sheet
        open={open}
        onOpenChange={setOpen}
        side="left"
        title="Navigation"
        titleHidden
        className="lg:hidden"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-5">
          {brand}
          {/* Dragging it closed is the quicker way, but a gesture nobody is
              told about cannot be the only way out. */}
          <SheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close navigation">
              <X />
            </Button>
          </SheetClose>
        </div>
        {/* Contained, so scrolling to the end of the navigation does not
            start scrolling the page behind the drawer. */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <SidebarNav
            sections={sections}
            instanceId="drawer"
            onNavigate={() => setOpen(false)}
          />
        </div>
      </Sheet>

      <div className="lg:pl-60">
        <header
          className={cn(
            'material sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 transition-[border-color,box-shadow] duration-fast ease-out sm:px-6',
            /*
             * The edge appears only when there is something under it.
             *
             * A permanent 1px rule draws a line whether or not the page has
             * been scrolled, which says "there is content above" when there
             * is not. Tied to the scroll position it says what it means, and
             * at rest the header simply meets the page.
             */
            scrolled ? 'border-border shadow-chip' : 'border-transparent',
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
          >
            <Menu />
          </Button>
          {header}
        </header>
        <main id="main" className="px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Whether the page has been scrolled at all.
 *
 * Passive, and it only ever flips a boolean, so the listener costs a compare
 * per frame of scrolling rather than a re-render.
 */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => {
      setScrolled((previous) => {
        const next = window.scrollY > 0;
        return next === previous ? previous : next;
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return scrolled;
}

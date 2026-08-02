'use client';

import { Menu, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import type { NavSection } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { SidebarNav } from './sidebar-nav';

/**
 * Two-column shell: a permanent sidebar from `lg` up, and a slide-over
 * beneath it. The ops team works on laptops, so the desktop layout is the
 * one that matters — tablet is the floor, phones are out of scope.
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

  return (
    <div className="min-h-screen">
      {/* Permanent sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-card lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          {brand}
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav sections={sections} />
        </div>
      </aside>

      {/* Slide-over for tablet */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpen(false)}
          />
          <aside className="relative flex h-full w-64 flex-col border-r bg-card">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-5">
              {brand}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
              >
                <X />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <SidebarNav sections={sections} onNavigate={() => setOpen(false)} />
            </div>
          </aside>
        </div>
      ) : null}

      <div className={cn('lg:pl-60')}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>
          {header}
        </header>
        <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

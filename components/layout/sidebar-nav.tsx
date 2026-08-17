'use client';

import {
  Building2,
  Car,
  CalendarClock,
  CalendarSync,
  ChartNoAxesColumn,
  ClipboardList,
  Contact,
  CreditCard,
  FileText,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SPRING } from '@/lib/motion';
import { isActive, type NavSection } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  ClipboardList,
  CalendarClock,
  CalendarSync,
  Users,
  Car,
  Contact,
  Building2,
  FileText,
  CreditCard,
  Wallet,
  ChartNoAxesColumn,
  Settings,
  ShieldCheck,
  Timer,
  KeyRound,
  Landmark,
  Wrench,
};

export function SidebarNav({
  sections,
  onNavigate,
  /**
   * Which copy of the navigation this is.
   *
   * The shell renders two — the permanent sidebar and the drawer — and both
   * are mounted at once, the wrong one merely hidden by a breakpoint. A
   * `layoutId` is global, so a single shared name would have Motion treat the
   * two highlights as one object and animate the marker between a visible
   * sidebar and a `display: none` drawer. Namespacing keeps each instance's
   * marker to itself.
   */
  instanceId = 'sidebar',
}: {
  sections: NavSection[];
  onNavigate?: () => void;
  instanceId?: string;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-6 px-3 py-4" aria-label="Main">
      {sections.map((section, index) => (
        <div key={section.heading ?? `section-${index}`}>
          {section.heading ? (
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {section.heading}
            </p>
          ) : null}
          <ul className="space-y-1">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon] ?? ClipboardList;
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'press relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
                      active
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    {/*
                      One highlight that moves, rather than one appearing here
                      as another disappears there.

                      `layoutId` makes Motion treat the two as the same object
                      across renders, so navigating slides the marker from the
                      old item to the new one. That is the difference between
                      the sidebar telling you *where you went* and telling you
                      only where you now are — and the interruption case comes
                      free: clicking a third item mid-slide re-targets the
                      spring from wherever the marker currently is instead of
                      restarting it.

                      Behind the label, so the text is never animated.
                    */}
                    {active ? (
                      <motion.span
                        layoutId={`${instanceId}-active`}
                        className="absolute inset-0 -z-10 rounded-md bg-primary"
                        transition={SPRING.snappy}
                      />
                    ) : null}
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

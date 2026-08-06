'use client';

import {
  Building2,
  Car,
  CalendarClock,
  ChartNoAxesColumn,
  ClipboardList,
  Contact,
  CreditCard,
  FileText,
  KeyRound,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActive, type NavSection } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  ClipboardList,
  CalendarClock,
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
  Wrench,
};

export function SidebarNav({
  sections,
  onNavigate,
}: {
  sections: NavSection[];
  onNavigate?: () => void;
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
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
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

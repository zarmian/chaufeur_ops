import type { Capability } from './permissions';

/**
 * The sidebar, as data.
 *
 * Each item names the capability it needs. Hiding a link a role cannot use
 * is a courtesy, not a control — the page and every action behind it check
 * the same capability server-side.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Lucide icon name, resolved in the client component. */
  icon: string;
  capability: Capability;
  /** Match nested routes, e.g. /jobs/123 highlights Jobs. */
  matchPrefix?: boolean;
}

export interface NavSection {
  heading: string | null;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    heading: null,
    items: [
      {
        href: '/',
        label: 'Dashboard',
        icon: 'LayoutDashboard',
        capability: 'viewJobs',
      },
    ],
  },
  {
    heading: 'Operations',
    items: [
      {
        href: '/jobs',
        label: 'Jobs',
        icon: 'ClipboardList',
        capability: 'viewJobs',
        matchPrefix: true,
      },
      {
        href: '/dispatch',
        label: 'Dispatch',
        icon: 'CalendarClock',
        capability: 'dispatch',
        matchPrefix: true,
      },
      {
        href: '/drivers',
        label: 'Drivers',
        icon: 'Users',
        capability: 'viewJobs',
        matchPrefix: true,
      },
      {
        href: '/vehicles',
        label: 'Vehicles',
        icon: 'Car',
        capability: 'viewJobs',
        matchPrefix: true,
      },
    ],
  },
  {
    heading: 'Commercial',
    items: [
      {
        href: '/clients',
        label: 'Clients',
        icon: 'Contact',
        capability: 'viewJobs',
        matchPrefix: true,
      },
      {
        href: '/accounts',
        label: 'Accounts',
        icon: 'Building2',
        capability: 'viewJobs',
        matchPrefix: true,
      },
      {
        href: '/invoices',
        label: 'Invoices',
        icon: 'FileText',
        capability: 'viewInvoices',
        matchPrefix: true,
      },
      {
        href: '/payouts',
        label: 'Payouts',
        icon: 'Wallet',
        capability: 'viewInvoices',
        matchPrefix: true,
      },
      {
        href: '/reports',
        label: 'Reports',
        icon: 'ChartNoAxesColumn',
        capability: 'viewReports',
        matchPrefix: true,
      },
    ],
  },
  {
    heading: 'Admin',
    items: [
      {
        href: '/settings',
        label: 'Settings',
        icon: 'Settings',
        capability: 'manageSettings',
        matchPrefix: true,
      },
    ],
  },
];

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/';
  return item.matchPrefix
    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
    : pathname === item.href;
}

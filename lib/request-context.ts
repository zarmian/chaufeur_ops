import { headers } from 'next/headers';
import type { AuditContext } from './audit';
import { requireCapability, type Capability, type SessionUser } from './authz';
import { clientIpFrom } from './rate-limit';

/**
 * Who is acting, and from where — the two things every audit entry needs.
 *
 * Bundled with the capability check so a Server Action cannot accidentally
 * record a change without also having verified the caller may make it. The
 * two belong together: an audited action by an unauthorised user is still an
 * unauthorised action.
 */
export async function actingUser(
  capability: Capability,
): Promise<{ user: SessionUser; audit: AuditContext }> {
  const user = await requireCapability(capability);
  const ip = clientIpFrom(await headers());
  return { user, audit: { userId: user.id, ip } };
}

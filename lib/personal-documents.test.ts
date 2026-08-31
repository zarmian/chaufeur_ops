import { describe, expect, it } from 'vitest';
import { isPersonalDocument } from './documents';
import { can, type SessionUser } from './permissions';

/**
 * Which papers a read-only account can open.
 *
 * `viewJobs` gated every document, and every role holds `viewJobs` — so a
 * temporary account created for an outside bookkeeper could pull two hundred
 * drivers' DVLA licences and DBS certificates. Consistent with "VIEWER is
 * read-only throughout", and still the wrong answer: a criminal-records
 * disclosure is not the same kind of thing as a pickup address.
 */

const asRole = (role: SessionUser['role']) =>
  ({ role }) as Pick<SessionUser, 'role'>;

describe('what counts as personal', () => {
  it('treats a driver’s own papers as personal', () => {
    for (const type of ['DVLA_LICENCE', 'PHV_BADGE', 'DBS']) {
      expect(isPersonalDocument({ type, driverId: 'drv_1' }), type).toBe(true);
    }
  });

  it('treats a car’s papers as ordinary', () => {
    // Dispatch reads these constantly, and they are commercial facts about a
    // vehicle rather than personal information about a person.
    for (const type of ['MOT', 'INSURANCE', 'PHV_VEHICLE', 'V5_LOGBOOK']) {
      expect(
        isPersonalDocument({ type, driverId: null, vehicleId: 'veh_1' } as never),
        type,
      ).toBe(false);
    }
  });

  it('treats anything filed against a driver as personal, whatever its type', () => {
    // The type says `MOT`, but it is hanging off a person. Whoever filed it
    // meant something, and guessing generously is the direction that leaks.
    expect(isPersonalDocument({ type: 'MOT', driverId: 'drv_1' })).toBe(true);
  });

  it('treats "Other" as personal even with no owner recorded', () => {
    // The type somebody picks when none of the others fit. What ends up under
    // it cannot be predicted, so an unknown is treated as sensitive.
    expect(isPersonalDocument({ type: 'OTHER', driverId: null })).toBe(true);
  });
});

describe('who may open one', () => {
  it('lets the roles that run the operation see them', () => {
    for (const role of ['ADMIN', 'OPS', 'ACCOUNTS'] as const) {
      expect(can(asRole(role), 'viewDriverDocuments'), role).toBe(true);
    }
  });

  it('does not let a read-only account download a driver’s licence', () => {
    // The finding. VIEWER keeps `viewJobs` and loses this.
    expect(can(asRole('VIEWER'), 'viewDriverDocuments')).toBe(false);
    expect(can(asRole('VIEWER'), 'viewJobs')).toBe(true);
  });
});

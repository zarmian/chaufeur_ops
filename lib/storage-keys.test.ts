import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  buildObjectKey,
  describeUploadRefusal,
  keyBelongsTo,
  parseObjectKey,
  parseUploadOwner,
  sanitiseFileName,
} from './storage-keys';

/**
 * The names and limits both ends of an upload have to agree on.
 *
 * Documents go from the browser straight to Blob storage, so the browser
 * proposes the object key and the server signs a token scoped to it. That
 * makes `parseObjectKey` and `keyBelongsTo` load-bearing in a way a naming
 * helper normally is not: they are the only thing standing between "upload my
 * vehicle's MOT" and "upload into another vehicle's namespace", and the
 * caller of the token route is a browser, which is to say an attacker with a
 * debugger.
 */

describe('sanitising a file name', () => {
  it('keeps the tail and drops any path', () => {
    expect(sanitiseFileName('C:\\Users\\ops\\mot.pdf')).toBe('mot.pdf');
    expect(sanitiseFileName('/etc/passwd')).toBe('passwd');
  });

  it('flattens spaces and strips punctuation that could confuse a header', () => {
    expect(sanitiseFileName('MOT  certificate (2026).pdf')).toBe(
      'MOT-certificate-2026.pdf',
    );
  });

  it('never returns an empty name', () => {
    expect(sanitiseFileName('')).toBe('file');
    expect(sanitiseFileName('...')).toBe('file');
    expect(sanitiseFileName('***')).toBe('file');
  });

  it('cannot be made to climb out of its folder', () => {
    // The dots survive as characters but the separators do not, so the result
    // is a name rather than a path.
    expect(sanitiseFileName('../../secrets.pdf')).not.toContain('/');
    expect(sanitiseFileName('../../secrets.pdf')).toBe('secrets.pdf');
  });
});

describe('building a key', () => {
  it('namespaces by entity, so the owner is readable from the key', () => {
    expect(buildObjectKey('vehicle', 'veh_1', 'uuid-1', 'mot.pdf')).toBe(
      'documents/vehicle/veh_1/uuid-1-mot.pdf',
    );
  });

  it('round-trips through the parser', () => {
    const key = buildObjectKey('driver', 'drv_9', 'uuid-2', 'badge.png');
    expect(parseObjectKey(key)).toEqual({
      prefix: 'documents',
      entityType: 'driver',
      entityId: 'drv_9',
      fileName: 'uuid-2-badge.png',
    });
  });
});

describe('parsing a key the browser proposed', () => {
  it('accepts one of ours', () => {
    expect(parseObjectKey('documents/vehicle/veh_1/uuid-mot.pdf')).not.toBeNull();
  });

  it('refuses traversal, absolute paths and backslashes', () => {
    for (const key of [
      'documents/vehicle/../driver/drv_1/x.pdf',
      '/documents/vehicle/veh_1/x.pdf',
      'documents\\vehicle\\veh_1\\x.pdf',
      'documents/vehicle/veh_1/../../../x.pdf',
    ]) {
      expect(parseObjectKey(key), key).toBeNull();
    }
  });

  it('refuses the wrong number of segments', () => {
    for (const key of [
      'documents/vehicle/veh_1',
      'documents/vehicle/veh_1/nested/x.pdf',
      'x.pdf',
      '',
    ]) {
      expect(parseObjectKey(key), key).toBeNull();
    }
  });

  it('refuses empty segments', () => {
    expect(parseObjectKey('documents//veh_1/x.pdf')).toBeNull();
    expect(parseObjectKey('documents/vehicle/veh_1/')).toBeNull();
  });
});

describe('whether a key belongs to the entity being uploaded to', () => {
  it('accepts the entity’s own namespace', () => {
    expect(keyBelongsTo('documents/vehicle/veh_1/u-mot.pdf', 'vehicle', 'veh_1')).toBe(
      true,
    );
  });

  it('refuses another entity’s namespace', () => {
    /*
     * The attack this exists for. The browser names the pathname it wants a
     * token for, so without this check an operator with rights to one vehicle
     * could have the server sign a write into any other record's folder — or
     * over an existing document, if they knew its key.
     */
    expect(keyBelongsTo('documents/vehicle/veh_2/u-mot.pdf', 'vehicle', 'veh_1')).toBe(
      false,
    );
  });

  it('refuses the other entity type', () => {
    expect(keyBelongsTo('documents/driver/veh_1/u-mot.pdf', 'vehicle', 'veh_1')).toBe(
      false,
    );
  });

  it('refuses anything outside the documents prefix', () => {
    // Branding assets and anything else live elsewhere and are not writable
    // through the document token route.
    expect(keyBelongsTo('branding/vehicle/veh_1/u-logo.svg', 'vehicle', 'veh_1')).toBe(
      false,
    );
  });

  it('refuses a key it cannot parse at all', () => {
    expect(keyBelongsTo('', 'vehicle', 'veh_1')).toBe(false);
    expect(keyBelongsTo('nonsense', 'vehicle', 'veh_1')).toBe(false);
  });
});

describe('refusing a file', () => {
  it('accepts the four document types', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(describeUploadRefusal({ type, size: 1000 }), type).toBeNull();
    }
  });

  it('refuses anything else by name', () => {
    const message = describeUploadRefusal({ type: 'image/svg+xml', size: 1000 });
    expect(message).toContain('not an accepted file type');
  });

  it('refuses an empty file', () => {
    expect(describeUploadRefusal({ type: 'application/pdf', size: 0 })).toContain(
      'empty',
    );
  });

  it('accepts a file right up to the limit', () => {
    /*
     * The case the whole change is about. A scanned MOT certificate at three
     * or four megabytes used to be rejected by the framework before any of
     * this code ran, and the operator saw the generic error boundary.
     */
    expect(
      describeUploadRefusal({ type: 'application/pdf', size: 4 * 1024 * 1024 }),
    ).toBeNull();
    expect(
      describeUploadRefusal({ type: 'application/pdf', size: MAX_UPLOAD_BYTES }),
    ).toBeNull();
  });

  it('refuses one byte past it, and says how big it was', () => {
    const message = describeUploadRefusal({
      type: 'application/pdf',
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect(message).toContain('10.0 MB');
    expect(message).toContain('The limit is 10 MB');
  });
});

describe('the owner a browser claims an upload is for', () => {
  it('accepts exactly one owner', () => {
    expect(parseUploadOwner('{"vehicleId":"veh_1"}')).toEqual({ vehicleId: 'veh_1' });
    expect(parseUploadOwner('{"driverId":"drv_1"}')).toEqual({ driverId: 'drv_1' });
  });

  it('refuses both at once', () => {
    /*
     * The rule worth testing. With two owners the route would have to pick
     * one to check the pathname against, and whichever it picked, the other
     * would be a namespace nobody validated.
     */
    expect(parseUploadOwner('{"driverId":"drv_1","vehicleId":"veh_1"}')).toBeNull();
  });

  it('refuses neither', () => {
    expect(parseUploadOwner('{}')).toBeNull();
    expect(parseUploadOwner('{"driverId":""}')).toBeNull();
    expect(parseUploadOwner('{"driverId":null}')).toBeNull();
  });

  it('refuses anything that is not an object with string ids', () => {
    expect(parseUploadOwner('{"vehicleId":123}')).toBeNull();
    expect(parseUploadOwner('{"vehicleId":{"toString":"x"}}')).toBeNull();
    expect(parseUploadOwner('["veh_1"]')).toBeNull();
    expect(parseUploadOwner('"veh_1"')).toBeNull();
    expect(parseUploadOwner('not json')).toBeNull();
    expect(parseUploadOwner(null)).toBeNull();
    expect(parseUploadOwner('')).toBeNull();
  });

  it('carries nothing across from the payload but the id it recognised', () => {
    // So a crafted payload cannot smuggle extra keys into whatever the route
    // does with the result.
    expect(parseUploadOwner('{"vehicleId":"veh_1","role":"ADMIN"}')).toEqual({
      vehicleId: 'veh_1',
    });
  });
});

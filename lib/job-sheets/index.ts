import { montclares } from './montclares';
import { readSheet, type JobSheetTemplate, type SheetRead } from './types';

export * from './types';

/**
 * The templates, in the order they are tried.
 *
 * A list rather than a lookup because a sheet does not say who wrote it in any
 * reliable field — the agency is recognised from how the page is laid out. Add
 * an agency by adding a template here; nothing else changes.
 */
export const TEMPLATES: JobSheetTemplate[] = [montclares];

export function readJobSheet(text: string): SheetRead {
  return readSheet(text, TEMPLATES);
}

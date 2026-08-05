import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getSettings } from '@/lib/settings';

export const metadata = { title: 'Compliance thresholds' };

export default async function ComplianceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const settings = await getSettings();

  const error = filterValue(query, 'settingsError');
  const saved = Boolean(filterValue(query, 'updated'));

  return (
    <>
      <PageHeader
        title="Compliance thresholds"
        description="How far ahead a lapsing document starts warning, and when the dashboard starts shouting about unpriced work."
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="settings-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved && !error ? (
        <Alert className="mb-6" data-testid="settings-saved">
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      ) : null}

      <form
        method="post"
        action="/api/settings/thresholds"
        className="max-w-2xl space-y-6"
        data-testid="thresholds-form"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="complianceWarningDays"
            label="Warn from (days)"
            hint="Amber. Time to plan the renewal."
            required
          >
            <Input
              id="complianceWarningDays"
              name="complianceWarningDays"
              type="number"
              min={1}
              max={365}
              defaultValue={settings.complianceWarningDays}
              required
              className="tabular"
            />
          </FormField>

          <FormField
            name="complianceCriticalDays"
            label="Escalate at (days)"
            hint="Red. Chase it now. Must sit inside the warning window, or the amber band disappears."
            required
          >
            <Input
              id="complianceCriticalDays"
              name="complianceCriticalDays"
              type="number"
              min={1}
              max={365}
              defaultValue={settings.complianceCriticalDays}
              required
              className="tabular"
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="driverConflictBufferMinutes"
            label="Driver clash window (minutes)"
            hint="Two jobs for one driver this close together raise a warning. Never a block — two airport runs an hour apart may be perfectly fine."
            required
          >
            <Input
              id="driverConflictBufferMinutes"
              name="driverConflictBufferMinutes"
              type="number"
              min={0}
              max={720}
              defaultValue={settings.driverConflictBufferMinutes}
              required
              className="tabular"
            />
          </FormField>

          <FormField
            name="unpricedAlertThreshold"
            label="Unpriced alert at"
            hint="Completed jobs with no price at which the dashboard tile turns red."
            required
          >
            <Input
              id="unpricedAlertThreshold"
              name="unpricedAlertThreshold"
              type="number"
              min={1}
              max={1000}
              defaultValue={settings.unpricedAlertThreshold}
              required
              className="tabular"
            />
          </FormField>
        </div>

        <div className="flex items-center gap-3 border-t pt-6">
          <Button type="submit">Save thresholds</Button>
        </div>
      </form>
    </>
  );
}

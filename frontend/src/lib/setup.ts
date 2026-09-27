export interface SetupStep {
  id: 'household' | 'accounts' | 'upload';
  label: string;
  to: string;
  done: boolean;
}

/** The three things a fresh install needs before the dashboard has anything to show. */
export function setupSteps(householdSaved: boolean, activeAccounts: number, uploads: number): SetupStep[] {
  return [
    {
      id: 'household',
      label: 'Name the two of you and set incomes',
      to: '/settings?tab=household',
      done: householdSaved,
    },
    {
      id: 'accounts',
      label: 'Add the accounts your statements come from',
      to: '/settings?tab=accounts',
      done: activeAccounts > 0,
    },
    { id: 'upload', label: 'Upload your first statement', to: '/upload', done: uploads > 0 },
  ];
}

/** True once the steps are known and at least one is still to do. */
export function setupIncomplete(steps: ReadonlyArray<SetupStep> | null): boolean {
  return steps !== null && steps.some((s) => !s.done);
}

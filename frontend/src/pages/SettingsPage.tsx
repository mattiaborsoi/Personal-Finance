import { Cog, Landmark } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { AccountsPanel } from '../components/AccountsPanel';
import { PRODUCT_NAME } from '../components/BrandMark';
import { PageHeader } from '../components/PageHeader';
import { SystemPanel } from '../components/SystemPanel';
import { Tabs, type TabItem } from '../components/Tabs';

type SettingsTab = 'accounts' | 'system';

const TABS: ReadonlyArray<TabItem<SettingsTab>> = [
  { id: 'accounts', label: 'Accounts', icon: Landmark },
  { id: 'system', label: 'System', icon: Cog },
];

/** The URL holds the active tab (`?tab=accounts|system`); anything else means Accounts. */
function readTab(params: URLSearchParams): SettingsTab {
  return params.get('tab') === 'system' ? 'system' : 'accounts';
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description={`Your accounts, and the version of ${PRODUCT_NAME} that is running.`} />
      <Tabs tabs={TABS} active={tab} label="Settings sections" onChange={(next) => setSearchParams({ tab: next })}>
        {tab === 'system' ? <SystemPanel /> : <AccountsPanel />}
      </Tabs>
    </div>
  );
}

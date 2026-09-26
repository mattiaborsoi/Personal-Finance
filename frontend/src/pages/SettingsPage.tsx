import { Cog, Landmark, Sparkles } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { AccountsPanel } from '../components/AccountsPanel';
import { AiPanel } from '../components/AiPanel';
import { PRODUCT_NAME } from '../components/BrandMark';
import { PageHeader } from '../components/PageHeader';
import { SystemPanel } from '../components/SystemPanel';
import { Tabs, type TabItem } from '../components/Tabs';

type SettingsTab = 'accounts' | 'ai' | 'system';

const TABS: ReadonlyArray<TabItem<SettingsTab>> = [
  { id: 'accounts', label: 'Accounts', icon: Landmark },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'system', label: 'System', icon: Cog },
];

/** The URL holds the active tab (`?tab=accounts|ai|system`); anything else means Accounts. */
function readTab(params: URLSearchParams): SettingsTab {
  const tab = params.get('tab');
  return tab === 'ai' || tab === 'system' ? tab : 'accounts';
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={`Your accounts, how ${PRODUCT_NAME} uses AI, and the version that is running.`}
      />
      <Tabs tabs={TABS} active={tab} label="Settings sections" onChange={(next) => setSearchParams({ tab: next })}>
        {tab === 'system' ? <SystemPanel /> : tab === 'ai' ? <AiPanel /> : <AccountsPanel />}
      </Tabs>
    </div>
  );
}

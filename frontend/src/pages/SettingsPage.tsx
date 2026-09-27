import { Cog, Landmark, ListChecks, Sparkles, Tags, Users } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { AccountsPanel } from '../components/AccountsPanel';
import { AiPanel } from '../components/AiPanel';
import { PRODUCT_NAME } from '../components/BrandMark';
import { CategoriesPanel } from '../components/CategoriesPanel';
import { HouseholdPanel } from '../components/HouseholdPanel';
import { PageHeader } from '../components/PageHeader';
import { RulesPanel } from '../components/RulesPanel';
import { SystemPanel } from '../components/SystemPanel';
import { Tabs, type TabItem } from '../components/Tabs';

type SettingsTab = 'accounts' | 'household' | 'categories' | 'rules' | 'ai' | 'system';

const TABS: ReadonlyArray<TabItem<SettingsTab>> = [
  { id: 'accounts', label: 'Accounts', icon: Landmark },
  { id: 'household', label: 'Household', icon: Users },
  { id: 'categories', label: 'Categories', icon: Tags },
  { id: 'rules', label: 'Rules', icon: ListChecks },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'system', label: 'System', icon: Cog },
];

/** The URL holds the active tab (`?tab=accounts|household|categories|rules|ai|system`); anything else means Accounts. */
function readTab(params: URLSearchParams): SettingsTab {
  const tab = params.get('tab');
  return TABS.some((t) => t.id === tab) ? (tab as SettingsTab) : 'accounts';
}

function panelFor(tab: SettingsTab) {
  switch (tab) {
    case 'household':
      return <HouseholdPanel />;
    case 'categories':
      return <CategoriesPanel />;
    case 'rules':
      return <RulesPanel />;
    case 'ai':
      return <AiPanel />;
    case 'system':
      return <SystemPanel />;
    default:
      return <AccountsPanel />;
  }
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={`Your accounts, household, categories and rules, how ${PRODUCT_NAME} uses AI, and the version that is running.`}
      />
      <Tabs tabs={TABS} active={tab} label="Settings sections" onChange={(next) => setSearchParams({ tab: next })}>
        {panelFor(tab)}
      </Tabs>
    </div>
  );
}

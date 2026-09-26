import { Archive, ArchiveRestore, Landmark, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type AccountOut } from '../api';
import { useConfig, useNames, useReloadConfig } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { accountName, accountTypeName, claimTypeLabel } from '../lib/format';
import { btnIcon, btnPrimary, cx, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { AccountDialog } from './AccountDialog';
import { Badge } from './Badge';
import { PRODUCT_NAME } from './BrandMark';
import { Card } from './Card';
import { ConfirmButton } from './ConfirmButton';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

type Dialog = { mode: 'create' } | { mode: 'edit'; account: AccountOut };

export const HAS_TRANSACTIONS_TITLE = 'Has transactions; archive it instead';

/** The Accounts tab of Settings: the table of accounts with add, edit, archive and delete. */
export function AccountsPanel() {
  const config = useConfig();
  const names = useNames();
  const reloadConfig = useReloadConfig();
  const accounts = useAsync(() => api.listAccounts(), 'accounts');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [syncError, setSyncError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  function personName(userId: string | null): string {
    if (!userId) return '—';
    if (userId === config.users.primary.id) return names.primary;
    if (userId === config.users.secondary.id) return names.secondary;
    return userId;
  }

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  /** The account dropdowns elsewhere read the config, so it must follow every change made here. */
  async function syncConfig() {
    try {
      await reloadConfig();
      setSyncError(null);
    } catch (err) {
      setSyncError(`Saved, but the account lists elsewhere could not be refreshed: ${errorMessage(err)}`);
    }
  }

  function saved(account: AccountOut) {
    setDialog(null);
    setRowError(account.id, null);
    accounts.setData((prev) => {
      if (!prev) return [account];
      return prev.some((a) => a.id === account.id) ? prev.map((a) => (a.id === account.id ? account : a)) : [...prev, account];
    });
    // The server sorts the list and counts transactions; the merge above only keeps the table from flashing.
    accounts.reload();
    void syncConfig();
  }

  async function setActive(account: AccountOut, isActive: boolean) {
    setRowError(account.id, null);
    try {
      const updated = await api.updateAccount(account.id, { is_active: isActive });
      accounts.setData((prev) => (prev ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev));
      await syncConfig();
    } catch (err) {
      setRowError(account.id, errorMessage(err));
    }
  }

  async function remove(account: AccountOut) {
    setRowError(account.id, null);
    try {
      await api.deleteAccount(account.id);
      accounts.setData((prev) => (prev ? prev.filter((a) => a.id !== account.id) : prev));
      await syncConfig();
    } catch (err) {
      setRowError(account.id, errorMessage(err));
    }
  }

  const addButton = (
    <button type="button" className={btnPrimary} onClick={() => setDialog({ mode: 'create' })}>
      <Plus className="h-4 w-4" aria-hidden="true" />
      Add account
    </button>
  );

  return (
    <>
      <Card
        flush
        icon={Landmark}
        title="Accounts"
        description={`The accounts your statements come from. ${PRODUCT_NAME} maps each upload to an account by the digits printed on it.`}
        actions={
          <>
            {accounts.loading && <LoadingState inline />}
            {addButton}
          </>
        }
      >
        {syncError && (
          <div className="px-5 pt-4 sm:px-6">
            <ErrorMessage message={syncError} onDismiss={() => setSyncError(null)} />
          </div>
        )}
        {accounts.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={accounts.error.message} onRetry={accounts.reload} />
          </div>
        )}
        {!accounts.data && !accounts.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState label="Loading accounts" rows={4} />
          </div>
        )}
        {accounts.data &&
          (accounts.data.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No accounts yet"
              hint="Add the accounts your statements come from; uploads are matched to them by institution and the digits on the statement."
              action={
                <button type="button" className={btnPrimary} onClick={() => setDialog({ mode: 'create' })}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add your first account
                </button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={cx(tableBase, tableFlush)}>
                <thead>
                  <tr>
                    <th scope="col" className={thBase}>
                      Account
                    </th>
                    <th scope="col" className={thBase}>
                      Institution
                    </th>
                    <th scope="col" className={thBase}>
                      Type
                    </th>
                    <th scope="col" className={thBase}>
                      Owner
                    </th>
                    <th scope="col" className={thBase}>
                      Last four
                    </th>
                    <th scope="col" className={thBase}>
                      Default claim type
                    </th>
                    <th scope="col" className={thBase}>
                      Billed to
                    </th>
                    <th scope="col" className={cx(thBase, 'text-right')}>
                      Transactions
                    </th>
                    <th scope="col" className={thBase}>
                      Status
                    </th>
                    <th scope="col" className={thBase}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {accounts.data.map((account) => {
                    const name = accountName(account);
                    const hasTransactions = account.transaction_count > 0;
                    const error = rowErrors[account.id];
                    return (
                      <tr key={account.id} className={trHover}>
                        <td className={tdBase}>
                          <p className="font-semibold text-ink">{name}</p>
                          <p className="mt-0.5 font-mono text-xs text-ink-3">{account.id}</p>
                          {error && (
                            <p role="alert" className="mt-1 max-w-xs text-xs text-critical-ink">
                              {error}
                            </p>
                          )}
                        </td>
                        <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{account.institution}</td>
                        <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{accountTypeName(account.account_type)}</td>
                        <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{personName(account.owner_user_id)}</td>
                        <td className={cx(tdBase, 'whitespace-nowrap tabular text-ink-2')}>··{account.identifier_last4}</td>
                        <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>
                          {claimTypeLabel(account.default_claim_type, names)}
                        </td>
                        <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{personName(account.billed_to)}</td>
                        <td className={cx(tdBase, 'text-right tabular')}>{account.transaction_count}</td>
                        <td className={tdBase}>
                          {account.is_active ? (
                            <Badge tone="green" dot>
                              Active
                            </Badge>
                          ) : (
                            <Badge tone="neutral" dot>
                              Archived
                            </Badge>
                          )}
                        </td>
                        <td className={cx(tdBase, 'text-right')}>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              className={btnIcon}
                              aria-label={`Edit ${name}`}
                              title="Edit"
                              onClick={() => setDialog({ mode: 'edit', account })}
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </button>
                            {account.is_active ? (
                              <button
                                type="button"
                                className={btnIcon}
                                aria-label={`Archive ${name}`}
                                title="Archive"
                                onClick={() => setActive(account, false)}
                              >
                                <Archive className="h-4 w-4" aria-hidden="true" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={btnIcon}
                                aria-label={`Restore ${name}`}
                                title="Restore"
                                onClick={() => setActive(account, true)}
                              >
                                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                              </button>
                            )}
                            <ConfirmButton
                              confirmLabel={`Delete ${name}?`}
                              onConfirm={() => remove(account)}
                              tone="danger"
                              icon={Trash2}
                              iconOnly
                              disabled={hasTransactions}
                              title={hasTransactions ? HAS_TRANSACTIONS_TITLE : undefined}
                            >
                              {`Delete ${name}`}
                            </ConfirmButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </Card>
      {dialog && (
        <AccountDialog
          account={dialog.mode === 'edit' ? dialog.account : null}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
    </>
  );
}

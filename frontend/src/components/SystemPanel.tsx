import { Cog, DatabaseBackup, Download, HardDriveDownload, LoaderCircle, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  api,
  BACKUP_BEFORE_UPDATE_FAILED,
  errorMessage,
  isApiError,
  type BackupItem,
  type BackupKind,
  type BackupsSummary,
  type SystemInfo,
} from '../api';
import { formatDate, formatDateTime, timeAgo } from '../lib/dates';
import { saveBlob } from '../lib/download';
import { formatBytes, plural } from '../lib/format';
import { btnIcon, btnPrimary, btnSecondary, cx, eyebrow, focusRing, linkBase } from '../lib/ui';
import { Badge, type BadgeTone } from './Badge';
import { Card } from './Card';
import { ConfirmButton } from './ConfirmButton';
import { DangerZone } from './DangerZone';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { Notice } from './Notice';
import { StatTile } from './StatTile';

interface Props {
  /** How often GET /api/system is polled while an update runs. */
  pollIntervalMs?: number;
}

export const MANUAL_UPDATE_COMMANDS = 'git pull && docker compose up -d --build';
export const UPDATE_ALREADY_RUNNING_MESSAGE = 'An update is already running.';
export const ALREADY_UP_TO_DATE_TITLE = 'Already running the latest version';
export const UPDATER_UNAVAILABLE_MESSAGE = 'The updater is not reachable, so the app cannot update itself.';
/** The System tab warns once the newest backup is older than this; the server uses the same limit. */
export const BACKUP_STALE_HOURS = 36;

const BACKUP_KIND_LABELS: Record<BackupKind, string> = {
  nightly: 'nightly',
  manual: 'manual',
  'pre-update': 'before an update',
};

function isStale(last: BackupItem | null, now = Date.now()): boolean {
  return !last || now - new Date(last.created_at).getTime() > BACKUP_STALE_HOURS * 3_600_000;
}

/** While the app restarts mid-update the gateway answers 502/503/504, or nothing at all. */
function isRestartError(err: unknown): boolean {
  return isApiError(err) && [0, 502, 503, 504].includes(err.status);
}

function UpdateLog({ log }: { log: string | null }) {
  return (
    <pre
      aria-live="polite"
      aria-label="Update log"
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-4 py-3 font-mono text-xs leading-5 text-ink-2"
    >
      {log || 'Waiting for output…'}
    </pre>
  );
}

function commitUrl(repository: string, commit: string): string {
  return `https://github.com/${repository}/commit/${commit}`;
}

/** The System tab of Settings: the running version, the latest on GitHub, self-update, and the danger zone. */
export function SystemPanel({ pollIntervalMs = 3000 }: Props) {
  // The danger zone keeps its place (and its state) while the version information loads, and is there if it fails.
  return (
    <div className="space-y-6">
      <VersionAndUpdate pollIntervalMs={pollIntervalMs} />
      <DangerZone />
    </div>
  );
}

/** The Version and Update cards. */
function VersionAndUpdate({ pollIntervalMs }: Required<Props>) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  /** What the last "Check again" found, for screen readers; the polling below never touches it. */
  const [checkResult, setCheckResult] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  /** True from "Update now" until the updater reports a final state, even before the server says "running". */
  const [watching, setWatching] = useState(false);
  /**
   * True once an update followed from this page has finished. The updater keeps
   * reporting "succeeded" until the next run, so a page opened later (or reloaded)
   * must not keep asking the user to reload.
   */
  const [completedHere, setCompletedHere] = useState(false);
  const [restarting, setRestarting] = useState(false);
  /** The server's reason when the backup before an update failed (so nothing was started). */
  const [backupFailed, setBackupFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSystem()
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const polling = watching || info?.updater.state === 'running';

  // Follow a running update until it ends; a failed request means the app is restarting, so keep going.
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      try {
        const next = await api.getSystem();
        if (cancelled) return;
        setInfo(next);
        setRestarting(false);
        if (next.updater.state !== 'running') {
          setWatching(false);
          setCompletedHere(true);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        if (isRestartError(err)) setRestarting(true);
        else setActionError(errorMessage(err));
      }
      timer = setTimeout(tick, pollIntervalMs);
    }
    timer = setTimeout(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, pollIntervalMs]);

  async function check() {
    setChecking(true);
    setCheckResult('');
    setActionError(null);
    try {
      const next = await api.checkForUpdates();
      setInfo(next);
      setCheckResult(
        next.update_available === true
          ? `Update available: ${next.changes_truncated ? `more than ${next.changes.length} commits` : plural(next.changes.length, 'commit')} behind.`
          : next.update_available === false
            ? 'Up to date.'
            : 'Could not tell whether an update is available.',
      );
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  async function startUpdate(skipBackup = false) {
    setActionError(null);
    setBackupFailed(null);
    try {
      const started = await api.startUpdate(skipBackup);
      setRestarting(false);
      setWatching(true);
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              updater: { ...prev.updater, state: 'running', started_at: started.started_at, finished_at: null, log: null, error: null },
            }
          : prev,
      );
    } catch (err) {
      if (isApiError(err, 409) && err.message.startsWith(BACKUP_BEFORE_UPDATE_FAILED)) {
        setBackupFailed(err.message);
      } else if (isApiError(err, 409)) {
        setActionError(UPDATE_ALREADY_RUNNING_MESSAGE);
        setWatching(true);
      } else if (isApiError(err, 503)) {
        setActionError(UPDATER_UNAVAILABLE_MESSAGE);
      } else {
        setActionError(errorMessage(err));
      }
    }
  }

  if (!info) {
    return (
      <Card icon={Cog} title="Version">
        {loadError ? (
          <ErrorMessage message={loadError} onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <LoadingState label="Loading system information" rows={2} />
        )}
      </Card>
    );
  }

  const { updater } = info;
  const status: { tone: BadgeTone; label: string } =
    info.update_available === true
      ? { tone: 'amber', label: 'Update available' }
      : info.update_available === false
        ? { tone: 'green', label: 'Up to date' }
        : { tone: 'neutral', label: 'Unknown' };
  const latestValue = !info.update_check_enabled ? 'Checks disabled' : info.latest ? info.latest.short : 'Not checked';
  const latestHint =
    info.update_check_enabled && info.latest ? `${formatDateTime(info.latest.date)} · ${info.latest.message}` : undefined;
  /** Nothing to install when the running commit is the latest; unknown (null) still allows it. */
  const upToDate = info.update_available === false;
  const canUpdate = updater.available && updater.state !== 'running' && !upToDate;
  const updatedTo = info.running.short ?? info.latest?.short ?? 'the latest version';
  const { changes } = info;
  /** Every update skipped is listed, not only the latest; with nothing to compare against, the newest commits. */
  const changesHeading =
    info.update_available === true
      ? info.changes_truncated
        ? `More than ${changes.length} commits behind`
        : `${plural(changes.length, 'commit')} behind`
      : 'Recent changes on GitHub';

  return (
    <>
      <Card
        icon={Cog}
        title="Version"
        description={
          <>
            {info.app.name}
            {info.app.version ? ` ${info.app.version}` : ''} ·{' '}
            <a
              href={`https://github.com/${info.repository}/tree/${encodeURIComponent(info.branch)}`}
              target="_blank"
              rel="noreferrer"
              translate="no"
              className={linkBase}
              title="Opens on GitHub in a new tab"
            >
              {info.repository} ({info.branch})
            </a>
          </>
        }
        actions={
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <StatTile as="dl-item" label="Running" value={
              info.running.commit ? (
                <a
                  href={commitUrl(info.repository, info.running.commit)}
                  target="_blank"
                  rel="noreferrer"
                  translate="no"
                  className={cx(linkBase, 'font-mono')}
                  title="Opens this commit on GitHub in a new tab"
                >
                  {info.running.short}
                </a>
              ) : (
                <span className="font-mono">unknown</span>
              )
            } />
          <StatTile
            as="dl-item"
            label="Latest on GitHub"
            value={<span className={cx(info.latest && info.update_check_enabled && 'font-mono')}>{latestValue}</span>}
            hint={latestHint}
          />
        </dl>
        {changes.length > 0 && (
          <section className="mt-4">
            <h3 className={eyebrow}>{changesHeading}</h3>
            <ol aria-label="Changes" className="mt-2 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
              {changes.map((change) => (
                <li key={change.commit} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm sm:flex-nowrap">
                  <a
                    href={commitUrl(info.repository, change.commit)}
                    target="_blank"
                    rel="noreferrer"
                    translate="no"
                    className={cx(linkBase, 'font-mono text-xs')}
                    title="Opens this commit on GitHub in a new tab"
                  >
                    {change.short}
                  </a>{' '}
                  <span className="min-w-0 basis-full break-words text-ink sm:flex-1 sm:basis-auto">{change.message}</span>{' '}
                  <span className="shrink-0 text-xs text-ink-3">{formatDate(change.date)}</span>
                </li>
              ))}
            </ol>
            {info.changes_truncated && (
              <p className="mt-2 text-xs text-ink-3">
                Only the newest {changes.length} are listed; the running version is older than all of them.
              </p>
            )}
          </section>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnSecondary}
            onClick={check}
            disabled={checking || !info.update_check_enabled}
            title={info.update_check_enabled ? undefined : 'Update checks are disabled on the server'}
          >
            <RefreshCw className={cx('h-4 w-4', checking && 'animate-spin')} aria-hidden="true" />
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <ConfirmButton
            confirmLabel={`Update ${info.app.name} now? The app will restart.`}
            onConfirm={() => startUpdate()}
            icon={Download}
            disabled={!canUpdate}
            title={
              !updater.available
                ? 'Self-update is off: the updater is not reachable'
                : updater.state === 'running'
                  ? UPDATE_ALREADY_RUNNING_MESSAGE
                  : upToDate
                    ? ALREADY_UP_TO_DATE_TITLE
                    : undefined
            }
          >
            Update now
          </ConfirmButton>
          <p aria-live="polite" className="sr-only">
            {checkResult}
          </p>
        </div>
        <ErrorMessage message={actionError} onDismiss={() => setActionError(null)} className="mt-4" />
        {backupFailed && (
          <div className="mt-4 space-y-3">
            <ErrorMessage message={backupFailed} onDismiss={() => setBackupFailed(null)} />
            <ConfirmButton
              tone="danger"
              confirmLabel="Update without a backup? If the update goes wrong, there is no copy of the data from just before it."
              onConfirm={() => startUpdate(true)}
              icon={Download}
              disabled={!canUpdate}
            >
              Update without a backup
            </ConfirmButton>
          </div>
        )}
      </Card>

      <Card icon={Download} title="Update">
        {!updater.available ? (
          <Notice tone="neutral">
            <p>Self-update is off because the updater container is not reachable. Update from the server instead:</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-xs text-ink">
              <code>{MANUAL_UPDATE_COMMANDS}</code>
            </pre>
          </Notice>
        ) : updater.state === 'running' ? (
          <div className="space-y-3">
            <Notice tone="neutral" role="status" icon={RefreshCw}>
              {restarting
                ? 'Restarting… the app is coming back up.'
                : `Updating ${info.app.name}${updater.started_at ? `, started ${formatDateTime(updater.started_at)}` : ''}. The app will restart when it is done.`}
            </Notice>
            <UpdateLog log={updater.log} />
          </div>
        ) : updater.state === 'succeeded' && completedHere ? (
          <div className="space-y-3">
            <Notice
              tone="good"
              role="status"
              actions={
                <button type="button" className={btnPrimary} onClick={() => window.location.reload()}>
                  <RotateCw className="h-4 w-4" aria-hidden="true" />
                  Reload
                </button>
              }
            >
              Updated to {updatedTo}. Reload to use the new version.
            </Notice>
            {updater.log && (
              <details className="text-sm text-ink-2">
                <summary className={cx('cursor-pointer rounded font-medium hover:text-ink', focusRing)}>Update log</summary>
                <div className="mt-2">
                  <UpdateLog log={updater.log} />
                </div>
              </details>
            )}
          </div>
        ) : updater.state === 'succeeded' ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">
              The last update finished{updater.finished_at ? ` ${formatDateTime(updater.finished_at)}` : ''} and the app is
              running {info.running.short ?? 'the current version'}. Nothing is running now.
            </p>
            {updater.log && (
              <details className="text-sm text-ink-2">
                <summary className={cx('cursor-pointer rounded font-medium hover:text-ink', focusRing)}>Last update log</summary>
                <div className="mt-2">
                  <UpdateLog log={updater.log} />
                </div>
              </details>
            )}
          </div>
        ) : updater.state === 'failed' ? (
          <div className="space-y-3">
            <ErrorMessage message={`The last update failed${updater.error ? `: ${updater.error}` : '.'}`} />
            <UpdateLog log={updater.log} />
          </div>
        ) : (
          <p className="text-sm text-ink-2">
            Updating backs up the database, pulls the latest commit from GitHub, rebuilds the app and restarts it.
            Nothing is running now.
          </p>
        )}
      </Card>

      {info.backups && <BackupsCard summary={info.backups} />}
    </>
  );
}

/** Settings -> System -> Backups: the newest backup, "Back up now", downloads and the recent list. */
export function BackupsCard({ summary }: { summary: BackupsSummary }) {
  /** The list as re-read after "Back up now" or a delete; until then, the summary from GET /api/system. */
  const [items, setItems] = useState<BackupItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const recent = (items ?? summary.recent).slice(0, 5);
  const count = items ? items.length : summary.count;
  const last = items ? (items[0] ?? null) : summary.last;
  const stale = items ? isStale(last) : summary.stale;

  async function reload(fallback?: BackupItem) {
    try {
      setItems(await api.listBackups());
    } catch {
      if (fallback) setItems((prev) => [fallback, ...(prev ?? summary.recent)]);
    }
  }

  async function backUpNow() {
    setCreating(true);
    setError(null);
    setAnnouncement('');
    try {
      const made = await api.createBackup();
      setAnnouncement(`Backed up: ${formatBytes(made.bytes)}.`);
      await reload(made);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function download(item: BackupItem) {
    setDownloading(item.name);
    setError(null);
    try {
      saveBlob(await api.downloadBackup(item.name), item.name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDownloading(null);
    }
  }

  async function remove(item: BackupItem) {
    setError(null);
    try {
      await api.deleteBackup(item.name);
      setAnnouncement(`Deleted the backup from ${formatDateTime(item.created_at)}.`);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card
      icon={DatabaseBackup}
      title="Backups"
      description="Copies of the database, taken every night and before each update, kept on the server."
    >
      <div className="space-y-4">
        {stale && (
          <Notice tone="warning" role="status">
            {last
              ? `The last backup is from ${formatDateTime(last.created_at)}, more than a day and a half ago. Back up now, and check the server logs if this keeps happening.`
              : 'There is no backup of the database yet. Back up now.'}
          </Notice>
        )}
        {!summary.enabled && (
          <Notice tone="neutral">
            Nightly backups are turned off on this server (BACKUPS_ENABLED=false). Backups before updates and
            &ldquo;Back up now&rdquo; still work.
          </Notice>
        )}
        <p className="text-sm text-ink">
          {last
            ? `Last backup ${timeAgo(last.created_at)} (${BACKUP_KIND_LABELS[last.kind]}, ${formatBytes(last.bytes)})`
            : 'No backups yet'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimary} onClick={backUpNow} disabled={creating}>
            {creating ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <DatabaseBackup className="h-4 w-4" aria-hidden="true" />
            )}
            {creating ? 'Backing up…' : 'Back up now'}
          </button>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => last && download(last)}
            disabled={!last || downloading !== null}
          >
            <HardDriveDownload className="h-4 w-4" aria-hidden="true" />
            Download latest
          </button>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>
        {recent.length > 0 && (
          <section>
            <h3 className={eyebrow}>Recent backups</h3>
            <ul aria-label="Recent backups" className="mt-2 divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
              {recent.map((item) => {
                const when = formatDateTime(item.created_at);
                return (
                  <li key={item.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 text-ink">{when}</span>
                    <span className="text-xs text-ink-3">{BACKUP_KIND_LABELS[item.kind]}</span>
                    <span className="w-16 text-right text-xs tabular-nums text-ink-3">{formatBytes(item.bytes)}</span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        className={btnIcon}
                        onClick={() => download(item)}
                        disabled={downloading !== null}
                        aria-label={`Download the backup from ${when}`}
                        title="Download"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <ConfirmButton
                        iconOnly
                        tone="danger"
                        icon={Trash2}
                        ariaLabel={`Delete the backup from ${when}`}
                        confirmLabel="Delete this backup?"
                        onConfirm={() => remove(item)}
                      >
                        Delete
                      </ConfirmButton>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-ink-3">
              {plural(count, 'backup')} on the server. Older ones are removed automatically: the last 14 days, 8 weeks
              and 12 months of nightly backups are kept, and the last 10 taken before updates or by hand.
            </p>
          </section>
        )}
        <ErrorMessage message={error} onDismiss={() => setError(null)} />
      </div>
    </Card>
  );
}

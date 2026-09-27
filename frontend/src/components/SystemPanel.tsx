import { Cog, Download, RefreshCw, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, isApiError, type SystemInfo } from '../api';
import { formatDate, formatDateTime } from '../lib/dates';
import { plural } from '../lib/format';
import { btnPrimary, btnSecondary, cx, eyebrow, focusRing } from '../lib/ui';
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
export const UPDATER_UNAVAILABLE_MESSAGE = 'The updater is not reachable, so the app cannot update itself.';

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

  async function startUpdate() {
    setActionError(null);
    try {
      const started = await api.startUpdate();
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
      if (isApiError(err, 409)) {
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
  const canUpdate = updater.available && updater.state !== 'running';
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
        description={`${info.app.name} ${info.app.version} · ${info.repository} (${info.branch})`}
        actions={
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <StatTile as="dl-item" label="Running" value={
              <span translate="no" className="font-mono">
                {info.running.short ?? 'unknown'}
              </span>
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
                  <span translate="no" className="font-mono text-xs text-ink-3">
                    {change.short}
                  </span>{' '}
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
            onConfirm={startUpdate}
            icon={Download}
            disabled={!canUpdate}
            title={
              !updater.available
                ? 'Self-update is off: the updater is not reachable'
                : updater.state === 'running'
                  ? UPDATE_ALREADY_RUNNING_MESSAGE
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
            Updating pulls the latest commit from GitHub, rebuilds the app and restarts it. Nothing is running now.
          </p>
        )}
      </Card>
    </>
  );
}

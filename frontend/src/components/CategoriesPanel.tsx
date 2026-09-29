import { ArrowDown, ArrowUp, Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, CONFIG_DEFAULTS_MESSAGE, errorMessage, type CategoriesOut, type CategoryOut } from '../api';
import { useReloadConfig } from '../config/ConfigContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import {
  categoryLeaf,
  groupLabel,
  groupRuns,
  inUseTitle,
  isInUse,
  isProtectedCategory,
  moveItem,
  usageText,
} from '../lib/categories';
import { categoryLabel } from '../lib/format';
import { btnGhost, btnIcon, btnPrimary, btnSecondary, btnSmall, cx, eyebrow, fieldNoteId, inputBase, inputCompact, inputInvalid } from '../lib/ui';
import { Badge } from './Badge';
import { Card } from './Card';
import { ConfirmButton } from './ConfirmButton';
import { ErrorMessage } from './ErrorMessage';
import { Field } from './Field';
import { LoadingState } from './LoadingState';
import { Notice } from './Notice';

export const ORDER_DESCRIPTION = 'In the order the category menus show them; the part before the colon is the group.';
export const ADD_HINT = 'Group:Name, e.g. Bills:Phone. The part before the colon groups it with its neighbours.';
export const DUPLICATE_MESSAGE = 'That category is already in the list.';
export const RENAME_NOTE = 'Renames it everywhere: transactions, remembered merchants and rules.';
export const ALWAYS_KEPT_TITLE = 'Always kept: lines nothing classifies land here.';
export const EMOJI_HINT = 'Shown before the group in the category menus; leave it empty for none.';
export const CONFIG_STALE_MESSAGE = 'Saved, but the category menus elsewhere could not be refreshed';

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

interface RenameFormProps {
  name: string;
  busy: boolean;
  error?: string;
  onSave: (to: string) => void;
  onCancel: () => void;
}

/** The row's name as an input, with Save and Cancel; Enter saves and Escape cancels. */
function RenameForm({ name, busy, error, onSave, onCancel }: RenameFormProps) {
  const id = useId();
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  const canSave = Boolean(trimmed) && trimmed !== name && !busy;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSave) onSave(trimmed);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <form onSubmit={submit} className="min-w-0 flex-1 basis-full">
      <label htmlFor={id} className="sr-only">
        New name for {name}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="text"
          className={cx(inputBase, 'min-w-0 flex-1 basis-48', error && inputInvalid)}
          value={value}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-note`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className={cx(btnPrimary, btnSmall)} disabled={!canSave}>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {busy ? 'Renaming…' : 'Save'}
        </button>
        <button type="button" className={cx(btnSecondary, btnSmall)} disabled={busy} onClick={onCancel}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel
        </button>
      </div>
      <p id={`${id}-note`} className={cx('mt-1.5 text-xs', error ? 'text-critical-ink' : 'text-ink-3')} role={error ? 'alert' : undefined}>
        {error ?? RENAME_NOTE}
      </p>
    </form>
  );
}

interface EmojiFieldProps {
  group: string;
  /** The emoji the group has now; "" for none. */
  saved: string;
  /** What the group would show with nothing saved, as the field's placeholder. */
  placeholder: string;
  busy: boolean;
  onSave: (emoji: string) => void;
}

/** A group's emoji: saved on Enter or when the field is left, Escape puts it back; Clear saves "no emoji". */
function EmojiField({ group, saved, placeholder, busy, onSave }: EmojiFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const name = groupLabel(group);

  function commit() {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== saved) onSave(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
    }
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <input
        type="text"
        className={cx(inputCompact, 'w-12 px-1 text-center text-base')}
        aria-label={`Emoji for ${name}`}
        title={EMOJI_HINT}
        value={draft ?? saved}
        placeholder={placeholder}
        maxLength={8}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {saved && (
        <button
          type="button"
          className={cx(btnGhost, btnSmall, 'h-8 px-2')}
          aria-label={`Clear the emoji for ${name}`}
          disabled={busy}
          onClick={() => {
            setDraft(null);
            onSave('');
          }}
        >
          Clear
        </button>
      )}
    </span>
  );
}

interface RowProps {
  category: CategoryOut;
  index: number;
  count: number;
  busy: boolean;
  editing: boolean;
  error?: string;
  onMove: (delta: -1 | 1) => void;
  onRename: () => void;
  onRenamed: (to: string) => void;
  onCancelRename: () => void;
  onRemove: () => Promise<void>;
  /** A bare name is its own group, so its emoji field sits in the row. */
  emojiField?: ReactNode;
}

function CategoryRow({ category, index, count, busy, editing, error, onMove, onRename, onRenamed, onCancelRename, onRemove, emojiField }: RowProps) {
  const { name } = category;
  /** What the controls call the row: the full name, spelt the British way for Uncategorised. */
  const label = categoryLabel(name);
  const protectedRow = isProtectedCategory(name);
  const inUse = isInUse(category.in_use);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      {editing ? (
        <RenameForm name={name} busy={busy} error={error} onSave={onRenamed} onCancel={onCancelRename} />
      ) : (
        <>
          {emojiField}
          <div className="min-w-0 flex-1 basis-40">
            <p className="truncate text-sm font-semibold text-ink" title={label}>
              {protectedRow ? label : categoryLeaf(name)}
            </p>
            <p className="text-xs text-ink-3">{usageText(category.in_use)}</p>
          </div>
          <div className="flex items-center gap-1">
            {protectedRow && (
              <Badge tone="neutral" title={ALWAYS_KEPT_TITLE}>
                Always kept
              </Badge>
            )}
            <button
              type="button"
              className={btnIcon}
              aria-label={`Move ${label} up`}
              title="Move up"
              disabled={busy || index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={btnIcon}
              aria-label={`Move ${label} down`}
              title="Move down"
              disabled={busy || index === count - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </button>
            {!protectedRow && (
              <>
                <button type="button" className={btnIcon} aria-label={`Rename ${name}`} title="Rename" disabled={busy} onClick={onRename}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </button>
                <ConfirmButton
                  confirmLabel={`Remove ${name}?`}
                  onConfirm={onRemove}
                  tone="danger"
                  icon={Trash2}
                  iconOnly
                  disabled={busy || inUse}
                  title={inUse ? inUseTitle(category.in_use) : undefined}
                >
                  {`Remove ${name}`}
                </ConfirmButton>
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="basis-full text-xs text-critical-ink">
              {error}
            </p>
          )}
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** The Categories tab of Settings: the taxonomy in menu order, with rename, remove, reorder and add. Every change saves at once. */
export function CategoriesPanel() {
  const idBase = useId();
  const reloadConfig = useReloadConfig();

  const [data, setData] = useState<CategoriesOut | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /** A change is on its way to the server: every control waits, so two reorders cannot cross. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Every other change saves at once; only a name typed into "New category" and not yet added can be lost.
  useUnsavedChanges(Boolean(newName.trim()));

  useEffect(() => {
    let cancelled = false;
    api
      .getCategories()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function setRowError(name: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
  }

  /** The category menus elsewhere read the config, so it must follow every change made here. */
  async function syncConfig() {
    try {
      await reloadConfig();
      setSyncError(null);
    } catch (err) {
      setSyncError(`${CONFIG_STALE_MESSAGE}: ${errorMessage(err)}`);
    }
  }

  /** Runs one change; the refusal goes wherever `onError` puts it. True when it went through. */
  async function apply(action: () => Promise<CategoriesOut>, onError: (message: string) => void): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(await action());
      await syncConfig();
      return true;
    } catch (err) {
      onError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Card icon={Tags} title="Categories">
        {loadError ? (
          <ErrorMessage message={loadError} onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <LoadingState label="Loading the categories" rows={4} />
        )}
      </Card>
    );
  }

  const names = data.categories.map((c) => c.name);
  const runs = groupRuns(data.categories);
  const trimmedNew = newName.trim();
  const canAdd = Boolean(trimmedNew) && !busy;

  function move(index: number, delta: -1 | 1) {
    void apply(() => api.updateCategories(moveItem(names, index, index + delta)), setError);
  }

  async function remove(name: string) {
    setRowError(name, null);
    const ok = await apply(() => api.updateCategories(names.filter((n) => n !== name)), (message) => setRowError(name, message));
    if (ok) setNotice(`Removed ${name}.`);
  }

  async function rename(from: string, to: string) {
    setRowError(from, null);
    const ok = await apply(() => api.renameCategory(from, to), (message) => setRowError(from, message));
    if (ok) {
      setEditing(null);
      setNotice(`Renamed ${from} to ${to} everywhere.`);
    }
  }

  async function saveEmoji(group: string, emoji: string) {
    // The whole map of overrides goes back (a PUT replaces it): only groups that differ
    // from their default, so a default left alone keeps following the defaults.
    const defaults = data?.default_emojis ?? {};
    const wanted = { ...(data?.emojis ?? {}), [group]: emoji };
    const emojis = Object.fromEntries(Object.entries(wanted).filter(([g, e]) => e !== (defaults[g] ?? '')));
    const ok = await apply(() => api.updateCategories(names, emojis), setError);
    if (ok) setNotice(emoji ? `Saved ${emoji} for ${groupLabel(group)}.` : `Removed the emoji for ${groupLabel(group)}.`);
  }

  function emojiFor(group: string) {
    return (
      <EmojiField
        group={group}
        saved={data?.emojis?.[group] ?? ''}
        placeholder={data?.default_emojis?.[group] ?? ''}
        busy={busy}
        onSave={(emoji) => void saveEmoji(group, emoji)}
      />
    );
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!canAdd) return;
    // The server compares names ignoring case ("dining" is Dining), so the form does too.
    if (names.some((n) => n.toLowerCase() === trimmedNew.toLowerCase())) {
      setAddProblem(DUPLICATE_MESSAGE);
      return;
    }
    setAddProblem(null);
    const ok = await apply(() => api.updateCategories([...names, trimmedNew]), setAddProblem);
    if (ok) {
      setNewName('');
      setNotice(`Added ${trimmedNew}.`);
    }
  }

  const addId = `${idBase}-add`;

  return (
    <div className="space-y-6">
      {!data.stored && (
        <Notice tone="neutral" aria-label="Categories defaults">
          {CONFIG_DEFAULTS_MESSAGE}
        </Notice>
      )}
      <Card
        flush
        icon={Tags}
        title="Categories"
        description={ORDER_DESCRIPTION}
        actions={busy ? <LoadingState inline label="Saving" /> : undefined}
      >
        {(error || syncError || notice) && (
          <div className="space-y-2 px-5 pt-4 sm:px-6">
            <ErrorMessage message={error} onDismiss={() => setError(null)} />
            <ErrorMessage message={syncError} onDismiss={() => setSyncError(null)} />
            {notice && (
              <Notice tone="good" role="status">
                {notice}
              </Notice>
            )}
          </div>
        )}
        <div className="divide-y divide-hairline">
          {runs.map((run) => (
            <section key={`${run.group}-${run.items[0].index}`} className="px-5 py-3 sm:px-6" aria-label={run.grouped ? run.group : undefined}>
              {run.grouped && (
                <div className="flex items-center gap-3">
                  <h3 className={eyebrow}>{run.group}</h3>
                  {emojiFor(run.group)}
                </div>
              )}
              <ul className={cx(run.grouped && 'mt-1')}>
                {run.items.map(({ category, index }) => (
                  <CategoryRow
                    key={category.name}
                    category={category}
                    index={index}
                    count={names.length}
                    busy={busy}
                    editing={editing === category.name}
                    error={rowErrors[category.name]}
                    onMove={(delta) => move(index, delta)}
                    onRename={() => {
                      setRowError(category.name, null);
                      setEditing(category.name);
                    }}
                    onRenamed={(to) => rename(category.name, to)}
                    onCancelRename={() => {
                      setRowError(category.name, null);
                      setEditing(null);
                    }}
                    onRemove={() => remove(category.name)}
                    emojiField={run.grouped ? undefined : emojiFor(category.name)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <form onSubmit={add} noValidate className="border-t border-hairline px-5 py-4 sm:px-6">
          <Field id={addId} label="New category" help={ADD_HINT} problem={addProblem ?? undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={addId}
                type="text"
                className={cx(inputBase, 'min-w-0 flex-1 basis-48', addProblem && inputInvalid)}
                placeholder="e.g. Bills:Phone…"
                value={newName}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={addProblem ? true : undefined}
                aria-describedby={fieldNoteId(addId)}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setAddProblem(null);
                }}
              />
              <button type="submit" className={btnPrimary} disabled={!canAdd}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add category
              </button>
            </div>
          </Field>
        </form>
      </Card>
    </div>
  );
}

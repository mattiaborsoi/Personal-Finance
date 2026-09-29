import { Check, ChevronDown, LoaderCircle, Plus, Search } from 'lucide-react';
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage, UNCATEGORIZED, type CategorySuggestions } from '../api';
import { loadSuggestions, SUGGESTION_LIMIT } from '../lib/categorySuggestions';
import { AuthContext } from '../auth/AuthContext';
import { useConfig, useReloadConfig } from '../config/ConfigContext';
import {
  categoryEmoji,
  categoryEmojiLabel,
  categoryGroup,
  categoryLeaf,
  groupLabel,
  insertCategory,
  isGrouped,
  newCategoryOptions,
  searchCategories,
} from '../lib/categories';
import { categoryLabel, categoryOptions } from '../lib/format';
import { cx, inputBase, inputInvalid, selectCompact } from '../lib/ui';

/** How many shortcuts each of "Suggested" and "Most used" shows. */
const SHORTCUTS = SUGGESTION_LIMIT;
/** The popover's ceiling (20rem); it shrinks to the room there is. */
const MAX_HEIGHT = 320;
const MIN_WIDTH = 256;
const MAX_WIDTH = 352;
const GAP = 4;
const EDGE = 8;

// ---------------------------------------------------------------------------
// The list model
// ---------------------------------------------------------------------------

interface Item {
  /** Unique within the list: the same category may show under "Suggested" and under its group. */
  key: string;
  kind: 'option' | 'add';
  /** The category to pick (or to add). */
  value: string;
  text: string;
  emoji: string;
}

interface Section {
  key: string;
  /** Shown as a header and names the group for screen readers; none for a run of bare names. */
  title?: string;
  emoji?: string;
  /** The options sit under a group header, so they are inset a little. */
  indent?: boolean;
  items: Item[];
}

function shortcutItems(prefix: string, list: string[], emojis: Record<string, string> | undefined): Item[] {
  return list.map((value) => ({
    key: `${prefix}:${value}`,
    kind: 'option',
    value,
    text: categoryLabel(value),
    emoji: categoryEmoji(value, emojis),
  }));
}

/** Before anything is typed: the shortcuts, then every category under its group, Uncategorised last. */
function browseSections(
  options: string[],
  emojis: Record<string, string> | undefined,
  suggestions: CategorySuggestions | null,
): Section[] {
  const sections: Section[] = [];
  const known = new Set(options);
  if (suggestions) {
    const seen = new Set<string>();
    const take = (list: Array<{ category: string }>) => {
      const out: string[] = [];
      for (const { category } of list) {
        if (out.length >= SHORTCUTS) break;
        if (!known.has(category) || seen.has(category)) continue;
        seen.add(category);
        out.push(category);
      }
      return out;
    };
    const merchant = take(suggestions.merchant ?? []);
    const frequent = take(suggestions.frequent ?? []);
    if (merchant.length > 0) sections.push({ key: 'suggested', title: 'Suggested', items: shortcutItems('suggested', merchant, emojis) });
    if (frequent.length > 0) sections.push({ key: 'frequent', title: 'Most used', items: shortcutItems('frequent', frequent, emojis) });
  }

  // Groups gather wherever their members sit; bare names stay together in list order, headerless.
  const byGroup = new Map<string, Section>();
  let loose: Section | null = null;
  const all: Section[] = [];
  for (const value of options) {
    if (value === UNCATEGORIZED) continue;
    const emoji = categoryEmoji(value, emojis);
    if (isGrouped(value)) {
      const group = categoryGroup(value);
      let section = byGroup.get(group);
      if (!section) {
        section = { key: `group:${group}`, title: groupLabel(group), emoji, indent: true, items: [] };
        byGroup.set(group, section);
        all.push(section);
        loose = null;
      }
      section.items.push({ key: `all:${value}`, kind: 'option', value, text: categoryLeaf(value), emoji: '' });
    } else {
      if (!loose) {
        loose = { key: `loose:${value}`, items: [] };
        all.push(loose);
      }
      loose.items.push({ key: `all:${value}`, kind: 'option', value, text: categoryLabel(value), emoji });
    }
  }
  sections.push(...all);
  if (options.includes(UNCATEGORIZED)) {
    sections.push({
      key: 'uncategorized',
      items: [{ key: `all:${UNCATEGORIZED}`, kind: 'option', value: UNCATEGORIZED, text: categoryLabel(UNCATEGORIZED), emoji: '' }],
    });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Placement: below the button, or above it when there is more room there
// ---------------------------------------------------------------------------

interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

function place(trigger: HTMLElement): Placement {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), MAX_WIDTH, vw - 2 * EDGE);
  const left = Math.min(Math.max(rect.left, EDGE), Math.max(EDGE, vw - width - EDGE));
  const below = vh - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  if (below < MAX_HEIGHT && above > below) {
    return { left, width, bottom: vh - rect.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) };
  }
  return { left, width, top: rect.bottom + GAP, maxHeight: Math.max(Math.min(MAX_HEIGHT, below), 120) };
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

interface Props {
  value: string;
  onChange: (category: string) => void;
  /** The control's accessible name, e.g. "Category for Ocado". */
  label: string;
  /** Whose past categories to suggest; none for a rule. */
  merchant?: string | null;
  /** Offer to create a category from the search text (primary only, whatever this says). */
  allowAdd?: boolean;
  disabled?: boolean;
  /** `compact` is the 32px row control; `base` matches a full-size select. */
  size?: 'compact' | 'base';
  /** Width classes, the same ones the select it replaces had. */
  className?: string;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * A searchable category menu in place of a long native select: a button that
 * reads like the select (the group's emoji, "Group › Name"), opening a popover
 * with a search field (a WAI-ARIA combobox) over a grouped listbox, with the
 * merchant's past categories and the most used ones as shortcuts, and an option
 * to add a category that does not exist yet.
 */
export function CategoryPicker({
  value,
  onChange,
  label,
  merchant,
  allowAdd = true,
  disabled = false,
  size = 'compact',
  className,
  invalid,
  describedBy,
}: Props) {
  const config = useConfig();
  const reloadConfig = useReloadConfig();
  const session = useContext(AuthContext)?.session ?? null;
  const isPrimary = session?.role === 'primary';
  const emojis = config.category_emojis;
  const idBase = useId();
  const valueId = `${idBase}-value`;
  const listId = `${idBase}-list`;
  const optionId = (key: string) => `${idBase}-opt-${key.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0)}`)}`;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** The highlighted option's key; null means the default (the current value, or the first result). */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestions | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => categoryOptions(config.categories, value), [config.categories, value]);
  const canAdd = allowAdd && isPrimary;
  const suggestFor = isPrimary ? merchant?.trim() || null : null;

  const sections = useMemo<Section[]>(() => {
    if (!query.trim()) return browseSections(options, emojis, suggestions);
    const results = searchCategories(options, query);
    const found: Section[] =
      results.length > 0
        ? [{ key: 'results', items: shortcutItems('result', results, emojis) }]
        : [];
    if (canAdd) {
      const offers = newCategoryOptions(options, query, results);
      if (offers.length > 0) {
        found.push({
          key: 'add',
          items: offers.map((o) => ({ key: `add:${o.name}`, kind: 'add', value: o.name, text: o.label, emoji: '' })),
        });
      }
    }
    return found;
  }, [query, options, emojis, suggestions, canAdd]);
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const activeIndex = useMemo(() => {
    const chosen = activeKey === null ? -1 : items.findIndex((i) => i.key === activeKey);
    if (chosen >= 0) return chosen;
    const current = query.trim() ? -1 : items.findIndex((i) => i.value === value);
    return current >= 0 ? current : 0;
  }, [items, activeKey, query, value]);
  const activeItem = items[activeIndex] as Item | undefined;

  function moveTo(index: number) {
    const item = items[Math.max(0, Math.min(index, items.length - 1))];
    if (item) setActiveKey(item.key);
  }

  // The merchant's shortcuts, fetched the first time the menu opens for it.
  useEffect(() => {
    if (!open || !suggestFor) return;
    let cancelled = false;
    void loadSuggestions(suggestFor).then((result) => {
      if (!cancelled) setSuggestions(result);
    });
    return () => {
      cancelled = true;
    };
  }, [open, suggestFor]);

  // Sit next to the button, and follow it while anything scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (buttonRef.current) setPlacement(place(buttonRef.current));
    };
    // Scrolling the list itself moves nothing.
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && popRef.current?.contains(event.target))) update();
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // The popover mounts once it has a place, so the search box takes focus then.
  const placed = placement !== null;
  useEffect(() => {
    if (open && placed) inputRef.current?.focus({ preventScroll: true });
  }, [open, placed]);

  // A press anywhere else closes it, leaving focus where the press put it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    }
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open]);

  // Keep the highlighted option in view once the user moves it or types. On opening, the
  // list starts at the top so Suggested and Most used are what shows first, even when the
  // current value (often Uncategorised, the last entry) is far down.
  const activeId = activeItem ? optionId(activeItem.key) : undefined;
  const following = activeKey !== null || query.trim() !== '';
  useEffect(() => {
    if (open && activeId && following) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeId, placed, following]);

  function openMenu(initialQuery = '') {
    if (disabled) return;
    setQuery(initialQuery);
    setActiveKey(null);
    setError(null);
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    setPlacement(null);
    setQuery('');
    setError(null);
    if (returnFocus) buttonRef.current?.focus();
  }

  function pick(category: string) {
    close(true);
    if (category !== value) onChange(category);
  }

  async function add(name: string) {
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      await api.updateCategories(insertCategory(config.categories, name));
    } catch (err) {
      setError(errorMessage(err));
      setAdding(false);
      return;
    }
    try {
      await reloadConfig();
    } catch {
      // Saved all the same; the row keeps showing the new name until the config catches up.
    }
    setAdding(false);
    pick(name);
  }

  function choose(item: Item) {
    if (item.kind === 'add') void add(item.value);
    else pick(item.value);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(activeIndex - 1);
        break;
      case 'PageDown':
        event.preventDefault();
        moveTo(activeIndex + 8);
        break;
      case 'PageUp':
        event.preventDefault();
        moveTo(activeIndex - 8);
        break;
      case 'Enter':
        event.preventDefault();
        if (activeItem) choose(activeItem);
        break;
      case 'Escape':
        // Only the menu closes, not a dialog it sits in.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Focus goes back to the button first, so Tab carries on from there as if the menu had never opened.
        close(true);
        break;
      default:
    }
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing on the closed control starts a search with that letter.
      event.preventDefault();
      openMenu(event.key);
    }
  }

  const emoji = categoryEmoji(value, emojis);
  const text = categoryLabel(value);
  const fullLabel = categoryEmojiLabel(value, emojis);
  const trigger =
    size === 'compact'
      ? cx(selectCompact, 'relative text-left')
      : cx(inputBase, 'relative cursor-pointer pr-8 text-left');

  const popover =
    open && placement
      ? createPortal(
          <div
            ref={popRef}
            className="fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-pop"
            style={{
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              top: placement.top,
              bottom: placement.bottom,
            }}
          >
            <div className="border-b border-hairline p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" aria-hidden="true" />
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-label="Search categories"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeId}
                  autoComplete="off"
                  spellCheck={false}
                  className={cx(inputBase, 'h-8 py-1 pl-8 text-sm')}
                  placeholder={canAdd ? 'Search or add…' : 'Search…'}
                  value={query}
                  disabled={adding}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveKey(null);
                    setError(null);
                  }}
                  onKeyDown={onInputKeyDown}
                />
              </div>
            </div>
            <div id={listId} role="listbox" aria-label="Categories" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {sections.map((section) => {
                const body = section.items.map((item) => {
                  const selected = item.kind === 'option' && item.value === value;
                  const isActive = activeItem?.key === item.key;
                  return (
                    <div
                      key={item.key}
                      id={optionId(item.key)}
                      role="option"
                      aria-selected={selected}
                      data-value={item.value}
                      data-kind={item.kind}
                      className={cx(
                        'mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                        item.kind === 'add' ? 'font-medium text-brand' : 'text-ink',
                        isActive && 'bg-surface-3',
                        selected && 'font-semibold',
                        section.indent && 'pl-4',
                      )}
                      onMouseDown={(e: ReactMouseEvent) => e.preventDefault()}
                      onMouseMove={() => {
                        if (activeItem?.key !== item.key) setActiveKey(item.key);
                      }}
                      onClick={() => choose(item)}
                    >
                      {item.kind === 'add' ? (
                        adding && isActive ? (
                          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                        ) : (
                          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )
                      ) : (
                        item.emoji && (
                          <span className="w-5 shrink-0 text-center" aria-hidden="true">
                            {item.emoji}
                          </span>
                        )
                      )}
                      <span className="min-w-0 flex-1 truncate">{item.text}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />}
                    </div>
                  );
                });
                if (!section.title) {
                  return (
                    <div key={section.key} role="group" aria-label={section.key === 'add' ? 'New category' : undefined} className="py-0.5">
                      {body}
                    </div>
                  );
                }
                return (
                  <div key={section.key} role="group" aria-label={section.title} className="py-0.5">
                    <div aria-hidden="true" className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-2xs font-semibold uppercase text-ink-3">
                      {section.emoji && <span className="text-xs normal-case">{section.emoji}</span>}
                      {section.title}
                    </div>
                    {body}
                  </div>
                );
              })}
            </div>
            {items.length === 0 && (
              <p className="px-3 py-3 text-sm text-ink-3" role="status">
                No categories match.
              </p>
            )}
            {error && (
              <p role="alert" className="mx-2 mb-2 rounded-lg bg-critical/10 px-3 py-2 text-xs text-critical-ink">
                Could not add the category: {error}
              </p>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        value={value}
        className={cx(trigger, invalid && inputInvalid, className)}
        title={fullLabel}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={cx(valueId, describedBy) || undefined}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onButtonKeyDown}
      >
        {/* w-0 + min-w-full: fills the button without the label's length widening a table column. */}
        <span id={valueId} className="block w-0 min-w-full truncate">
          {emoji && <span aria-hidden="true">{emoji} </span>}
          {text}
        </span>
        <ChevronDown
          className={cx('pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3', size === 'compact' ? 'right-2' : 'right-3')}
          aria-hidden="true"
        />
      </button>
      {popover}
    </>
  );
}

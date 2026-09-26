import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  Minus,
  PlugZap,
  Server,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  errorMessage,
  isApiError,
  type AiJob,
  type AiModelOption,
  type AiModels,
  type AiProxyUpdate,
  type AiSettings,
  type AiTestResult,
  type AiThresholds,
  type AiUpdate,
  type EmbeddingProvider,
  type ProxyMode,
} from '../api';
import { plural } from '../lib/format';
import {
  btnPrimary,
  btnSecondary,
  cardInset,
  checkboxBase,
  cx,
  eyebrow,
  focusRing,
  inputBase,
  labelBase,
  radioBase,
  selectBase,
} from '../lib/ui';
import { Badge } from './Badge';
import { PRODUCT_NAME } from './BrandMark';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { Notice } from './Notice';
import { StatTile } from './StatTile';

export const SAVED_MESSAGE = 'Saved. New settings apply to the next upload.';
export const MODEL_LIST_UNAVAILABLE_MESSAGE =
  'The list of models could not be loaded from the proxy, so type the model names as they appear in its config.';
export const STALE_MODEL_LIST_MESSAGE = 'Save to refresh the list of models.';
export const PROXY_URL_PLACEHOLDER = 'http://host.docker.internal:4000';

// ---------------------------------------------------------------------------
// The jobs and the thresholds, as the form shows them
// ---------------------------------------------------------------------------

interface JobRow {
  job: AiJob;
  label: string;
  hint: string;
  /** Which of the proxy's models are offered: `chat` jobs list chat (or unknown) models, `embedding` the rest. */
  mode: 'chat' | 'embedding';
}

const JOBS: readonly JobRow[] = [
  { job: 'chat', label: 'Categorising transactions', hint: 'Many small questions; a cheaper, faster model is fine.', mode: 'chat' },
  { job: 'extraction', label: 'Reading awkward PDFs', hint: 'Only when the built-in parsers give up. Rare.', mode: 'chat' },
  { job: 'audit', label: 'Monthly summary', hint: 'One call a month; a stronger model writes a better sentence.', mode: 'chat' },
  { job: 'embedding', label: 'Merchant memory', hint: 'How merchants are turned into vectors so similar names match.', mode: 'embedding' },
];

const CHAT_JOBS: readonly AiJob[] = ['chat', 'extraction', 'audit'];

/** Short job names for the connection test results. */
const TEST_LABELS: Record<AiJob, string> = {
  chat: 'Categorising',
  extraction: 'Reading PDFs',
  audit: 'Monthly summary',
  embedding: 'Merchant memory',
};

/** The thresholds as typed: the two fractions edit as whole percentages, so 0.82 shows as 82. */
type ThresholdField = 'similarity' | 'top_k' | 'deviation' | 'lookback';
type ThresholdFields = Record<ThresholdField, string>;

const THRESHOLD_FIELDS: readonly ThresholdField[] = ['similarity', 'top_k', 'deviation', 'lookback'];

const THRESHOLDS: Record<ThresholdField, { key: keyof AiThresholds; min: number; max: number; percent: boolean }> = {
  similarity: { key: 'similarity_threshold', min: 50, max: 99, percent: true },
  top_k: { key: 'top_k', min: 1, max: 10, percent: false },
  deviation: { key: 'deviation_threshold', min: 5, max: 100, percent: true },
  lookback: { key: 'lookback_periods', min: 1, max: 12, percent: false },
};

interface ProxyFields {
  mode: ProxyMode;
  /** The external proxy's URL; blank while the bundled one is chosen and none was ever saved. */
  url: string;
  /** Never pre-filled: blank keeps the key already stored on the server. */
  api_key: string;
}

interface AiForm {
  enabled: boolean;
  embedding_provider: EmbeddingProvider;
  models: AiModels;
  thresholds: ThresholdFields;
  proxy: ProxyFields;
}

/** The URL saved for an external proxy; blank when the bundled one is in use. */
function savedExternalUrl(settings: AiSettings): string {
  return settings.proxy.mode === 'external' ? settings.proxy.url : '';
}

function formFrom(settings: AiSettings): AiForm {
  const thresholds = {} as ThresholdFields;
  for (const field of THRESHOLD_FIELDS) {
    const { key, percent } = THRESHOLDS[field];
    const value = settings.thresholds[key];
    thresholds[field] = String(percent ? Math.round(value * 100) : value);
  }
  return {
    enabled: settings.enabled,
    embedding_provider: settings.embedding_provider,
    models: { ...settings.models },
    thresholds,
    proxy: { mode: settings.proxy.mode, url: savedExternalUrl(settings), api_key: '' },
  };
}

/** The typed value as a whole number inside its range; null when it is not. */
function parseThreshold(field: ThresholdField, raw: string): number | null {
  if (!/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number(raw);
  const { min, max } = THRESHOLDS[field];
  return n >= min && n <= max ? n : null;
}

/** The jobs whose model matters: the embedding model is irrelevant while merchants are matched offline. */
function jobsInPlay(form: AiForm): readonly AiJob[] {
  return form.embedding_provider === 'hash' ? CHAT_JOBS : JOBS.map((row) => row.job);
}

/** A blank URL simply cannot be saved yet; a malformed one is pointed out. */
type ProxyUrlProblem = 'blank' | 'scheme';

export const PROXY_URL_SCHEME_MESSAGE = 'The URL must start with http:// or https://.';

function proxyUrlProblem(form: AiForm): ProxyUrlProblem | undefined {
  if (form.proxy.mode !== 'external') return undefined;
  const url = form.proxy.url.trim();
  if (!url) return 'blank';
  if (!/^https?:\/\//i.test(url)) return 'scheme';
  return undefined;
}

interface Parsed {
  /** Trimmed model names for the jobs in play, in the wire's shape. */
  models: Partial<AiModels>;
  /** Thresholds in the wire's units (fractions, not percentages). */
  thresholds: Partial<AiThresholds>;
  /** The proxy as the form has it: the URL only for an external one, the key only when typed. */
  proxy: AiProxyUpdate;
  /** Fields that cannot be sent: blank model names, thresholds outside their range, a missing or malformed proxy URL. */
  problems: { models: AiJob[]; thresholds: ThresholdField[]; proxyUrl?: ProxyUrlProblem };
}

function parseForm(form: AiForm): Parsed {
  const parsed: Parsed = { models: {}, thresholds: {}, proxy: { mode: form.proxy.mode }, problems: { models: [], thresholds: [] } };
  for (const job of jobsInPlay(form)) {
    const value = form.models[job].trim();
    if (value) parsed.models[job] = value;
    else parsed.problems.models.push(job);
  }
  for (const field of THRESHOLD_FIELDS) {
    const n = parseThreshold(field, form.thresholds[field]);
    if (n === null) parsed.problems.thresholds.push(field);
    else parsed.thresholds[THRESHOLDS[field].key] = THRESHOLDS[field].percent ? n / 100 : n;
  }
  if (form.proxy.mode === 'external') {
    parsed.proxy.url = form.proxy.url.trim();
    if (form.proxy.api_key.trim()) parsed.proxy.api_key = form.proxy.api_key;
  }
  parsed.problems.proxyUrl = proxyUrlProblem(form);
  return parsed;
}

function isValid(parsed: Parsed): boolean {
  return parsed.problems.models.length === 0 && parsed.problems.thresholds.length === 0 && !parsed.problems.proxyUrl;
}

/** Only what differs from the saved settings; an empty object means nothing changed. */
function buildUpdate(form: AiForm, parsed: Parsed, saved: AiSettings): AiUpdate {
  const body: AiUpdate = {};
  if (form.enabled !== saved.enabled) body.enabled = form.enabled;
  if (form.embedding_provider !== saved.embedding_provider) body.embedding_provider = form.embedding_provider;
  const models: Partial<AiModels> = {};
  for (const job of jobsInPlay(form)) {
    const value = parsed.models[job];
    if (value !== undefined && value !== saved.models[job]) models[job] = value;
  }
  if (Object.keys(models).length > 0) body.models = models;
  const base = formFrom(saved);
  const thresholds: Partial<AiThresholds> = {};
  for (const field of THRESHOLD_FIELDS) {
    const { key } = THRESHOLDS[field];
    const value = parsed.thresholds[key];
    // Compared as typed (whole percentages) so 0.82 read back and 82 typed in are the same thing.
    if (value !== undefined && form.thresholds[field].trim() !== base.thresholds[field]) thresholds[key] = value;
  }
  if (Object.keys(thresholds).length > 0) body.thresholds = thresholds;
  const proxy: AiProxyUpdate = {};
  if (parsed.proxy.mode !== saved.proxy.mode) proxy.mode = parsed.proxy.mode;
  if (parsed.proxy.url !== undefined && parsed.proxy.url !== savedExternalUrl(saved)) proxy.url = parsed.proxy.url;
  if (parsed.proxy.api_key !== undefined) proxy.api_key = parsed.proxy.api_key;
  if (Object.keys(proxy).length > 0) body.proxy = proxy;
  return body;
}

/** Everything on the form, for the connection test. */
function fullBody(form: AiForm, parsed: Parsed): AiUpdate {
  return {
    enabled: form.enabled,
    embedding_provider: form.embedding_provider,
    models: parsed.models,
    thresholds: parsed.thresholds,
    proxy: parsed.proxy,
  };
}

/** Mirrors the server's rule: the stored vectors stop being comparable when this is true. */
function embeddingChanged(form: AiForm, saved: AiSettings): boolean {
  if (form.embedding_provider !== saved.embedding_provider) return true;
  return form.embedding_provider === 'litellm' && form.models.embedding.trim() !== saved.models.embedding;
}

/** True when the model list on screen came from a different proxy than the form now points at. */
function proxyChanged(form: AiForm, saved: AiSettings): boolean {
  if (form.proxy.mode !== saved.proxy.mode) return true;
  return form.proxy.mode === 'external' && form.proxy.url.trim() !== savedExternalUrl(saved);
}

// ---------------------------------------------------------------------------
// Model options
// ---------------------------------------------------------------------------

interface Option {
  value: string;
  label: string;
}

/** "Anthropic · claude-haiku-4-5 (cheap-chat)" when the proxy says what is behind the name, else the bare name. */
function modelLabel(option: AiModelOption): string {
  return option.provider && option.model ? `${option.provider} · ${option.model} (${option.name})` : option.name;
}

/** The proxy's models that fit the job, with the current choice kept in the list even when the proxy no longer offers it. */
function optionsFor(available: AiModelOption[], mode: 'chat' | 'embedding', current: string): Option[] {
  const options = available
    .filter((option) => option.mode === mode || option.mode === null)
    .map((option) => ({ value: option.name, label: modelLabel(option) }));
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: `${current} (not listed by the proxy)` });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

interface ModelRowProps {
  id: string;
  label: string;
  hint: string;
  children: ReactNode;
}

/** A job: its bold name and one-line hint on the left, the control on the right. */
function ModelRow({ id, label, hint, children }: ModelRowProps) {
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink-3">
          {hint}
        </p>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

interface ModelControlProps {
  id: string;
  value: string;
  options: Option[];
  /** When the proxy's list cannot be trusted, the name is typed instead of chosen. */
  typed: boolean;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}

function ModelControl({ id, value, options, typed, disabled, invalid, onChange }: ModelControlProps) {
  if (typed) {
    return (
      <input
        id={id}
        type="text"
        className={cx(inputBase, 'font-mono', invalid && 'border-critical hover:border-critical')}
        value={value}
        placeholder="model name"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <select
      id={id}
      className={selectBase}
      value={value}
      disabled={disabled}
      aria-describedby={`${id}-hint`}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface FieldProps {
  id: string;
  label: string;
  help: string;
  /** Replaces the help text while the value cannot be sent. */
  problem?: string;
  /** The current value, shown beside the label. */
  readout?: string;
  /** Shown beside the label, e.g. a badge. */
  aside?: ReactNode;
  children: ReactNode;
}

/** Label over a control, with helper text that gives way to the field's problem. */
function Field({ id, label, help, problem, readout, aside, children }: FieldProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={labelBase}>
          {label}
        </label>
        {readout && <span className="text-sm font-semibold tabular text-ink">{readout}</span>}
        {aside}
      </div>
      <div className="mt-1.5">{children}</div>
      <p id={`${id}-help`} className={cx('mt-1.5 text-xs', problem ? 'text-critical-ink' : 'text-ink-3')}>
        {problem ?? help}
      </p>
    </div>
  );
}

function rangeProblem(field: ThresholdField): string {
  const { min, max } = THRESHOLDS[field];
  return `Enter a whole number between ${min} and ${max}.`;
}

/** One line of the connection test: the job, the model it used, how long it took, and why it failed. */
function TestLine({ job, result }: { job: AiJob; result: AiTestResult[AiJob] }) {
  const label = TEST_LABELS[job];
  if (result === null) {
    return (
      <li className="flex items-start gap-2 text-ink-3">
        <Minus className="mt-0.5 h-4 w-4 shrink-0" role="img" aria-label="Off" />
        <span>{label} · off</span>
      </li>
    );
  }
  const parts = [label, result.model];
  if (result.ms !== null) parts.push(`${result.ms} ms`);
  if ('dimensions' in result && result.dimensions !== null) parts.push(`${result.dimensions} dimensions`);
  return (
    <li className="flex items-start gap-2">
      {result.ok ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-good-ink" role="img" aria-label="OK" />
      ) : (
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-critical-ink" role="img" aria-label="Failed" />
      )}
      <div className="min-w-0">
        <p className="text-ink">{parts.join(' · ')}</p>
        {!result.ok && <p className="text-critical-ink">{result.error ?? 'The call failed.'}</p>}
      </div>
    </li>
  );
}

interface RadioProps {
  id: string;
  name: string;
  value: ProxyMode;
  checked: boolean;
  disabled: boolean;
  label: string;
  hint: ReactNode;
  onChange: (value: ProxyMode) => void;
}

/** A radio with a bold label and a one-line hint; the hint describes rather than names it. */
function ProxyRadio({ id, name, value, checked, disabled, label, hint, onChange }: RadioProps) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        className={cx(radioBase, 'mt-0.5')}
        aria-describedby={`${id}-hint`}
        onChange={() => onChange(value)}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm font-semibold text-ink">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink-3">
          {hint}
        </p>
      </div>
    </div>
  );
}

const switchTrack = `relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const switchKnob = 'inline-block h-5 w-5 rounded-full bg-surface shadow-sm transition-transform';

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** The AI tab of Settings: on/off, which proxy, which model does each job, the thresholds, and a connection test. */
export function AiPanel() {
  const idBase = useId();
  const f = (name: string) => `${idBase}-${name}`;

  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [form, setForm] = useState<AiForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  /** Ticked on the memory-reset warning; only meaningful while the warning shows. */
  const [clearMemory, setClearMemory] = useState(false);
  /** The server refused the last save with a 409, so the warning shows even when this form did not expect one. */
  const [conflict, setConflict] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [results, setResults] = useState<AiTestResult | null>(null);
  const [tuningOpen, setTuningOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getAi()
      .then((next) => {
        if (cancelled) return;
        setSaved(next);
        setForm(formFrom(next));
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function edit(patch: (prev: AiForm) => AiForm) {
    setForm((prev) => (prev ? patch(prev) : prev));
    setSavedNotice(false);
  }

  function setModel(job: AiJob, value: string) {
    edit((prev) => ({ ...prev, models: { ...prev.models, [job]: value } }));
  }

  function setThreshold(field: ThresholdField, value: string) {
    edit((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [field]: value } }));
  }

  function setProxy(patch: Partial<ProxyFields>) {
    edit((prev) => ({ ...prev, proxy: { ...prev.proxy, ...patch } }));
  }

  if (!saved || !form) {
    return (
      <Card icon={Sparkles} title="AI">
        {loadError ? (
          <ErrorMessage message={loadError} onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <LoadingState label="Loading the AI setup" rows={3} />
        )}
      </Card>
    );
  }

  const parsed = parseForm(form);
  const valid = isValid(parsed);
  const update = buildUpdate(form, parsed, saved);
  const dirty = Object.keys(update).length > 0;
  const showGuard = conflict || (embeddingChanged(form, saved) && saved.memory_rows > 0);
  const clearing = showGuard && clearMemory;
  const canSave = dirty && valid && !saving && (!showGuard || clearing);
  const reachable = saved.proxy.reachable;
  const staleList = proxyChanged(form, saved);
  /** The proxy's list is only worth offering when it came from the proxy the form points at. */
  const typedModels = !reachable || staleList;
  const external = form.proxy.mode === 'external';
  const busy = saving || testing;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const next = await api.updateAi(clearing ? { ...update, clear_memory: true } : update);
      setSaved(next);
      setForm(formFrom(next));
      setSavedNotice(true);
      setClearMemory(false);
      setConflict(false);
    } catch (err) {
      if (isApiError(err, 409)) setConflict(true);
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!form || !valid) return;
    setTesting(true);
    setTestError(null);
    setResults(null);
    try {
      setResults(await api.testAi(fullBody(form, parsed)));
    } catch (err) {
      setTestError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  const similarityReadout = `${form.thresholds.similarity}%`;
  const problem = (field: ThresholdField) => (parsed.problems.thresholds.includes(field) ? rangeProblem(field) : undefined);
  const badScheme = parsed.problems.proxyUrl === 'scheme';

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      <Card
        icon={Sparkles}
        title="AI"
        description={saved.stored ? undefined : 'Nothing saved yet: these are the defaults from config.yaml and .env.'}
        actions={
          <Badge tone={form.enabled ? 'green' : 'neutral'} dot>
            {form.enabled ? 'On' : 'Off'}
          </Badge>
        }
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p id={f('use-ai')} className="text-sm font-semibold text-ink">
              Use AI
            </p>
            <p id={f('use-ai-hint')} className="mt-0.5 max-w-prose text-sm text-ink-2">
              Categorises new merchants, reads PDFs the parsers cannot, and writes the monthly summary. When off, {PRODUCT_NAME} uses
              only your rules and the merchants it has already learnt.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            aria-labelledby={f('use-ai')}
            aria-describedby={f('use-ai-hint')}
            disabled={busy}
            onClick={() => edit((prev) => ({ ...prev, enabled: !prev.enabled }))}
            className={cx(switchTrack, form.enabled ? 'bg-brand' : 'bg-hairline-strong')}
          >
            <span aria-hidden="true" className={cx(switchKnob, form.enabled ? 'translate-x-[1.375rem]' : 'translate-x-0.5')} />
          </button>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <StatTile
            as="dl-item"
            label="Proxy reachable"
            value={reachable ? 'Yes' : 'No'}
            hint={<span className="font-mono">{saved.proxy.url}</span>}
          />
          <StatTile as="dl-item" label="Models available" value={saved.available_models.length} />
          <StatTile as="dl-item" label="Learnt merchants" value={saved.memory_rows} />
        </dl>
      </Card>

      <Card icon={Server} title="Proxy" description={`Where ${PRODUCT_NAME} sends its AI calls. LiteLLM holds the provider keys either way.`}>
        <fieldset className="space-y-3">
          <legend className="sr-only">Which LiteLLM proxy to use</legend>
          <ProxyRadio
            id={f('proxy-bundled')}
            name={f('proxy-mode')}
            value="bundled"
            checked={!external}
            disabled={busy}
            label="Bundled proxy"
            hint={
              <>
                The LiteLLM container that ships with {PRODUCT_NAME} (<code className="font-mono">docker compose</code>). Provider keys go
                in <code className="font-mono">.env</code>.
              </>
            }
            onChange={(mode) => setProxy({ mode })}
          />
          <ProxyRadio
            id={f('proxy-external')}
            name={f('proxy-mode')}
            value="external"
            checked={external}
            disabled={busy}
            label="My own LiteLLM"
            hint={`A LiteLLM proxy you already run, anywhere ${PRODUCT_NAME}'s containers can reach.`}
            onChange={(mode) => setProxy({ mode })}
          />
        </fieldset>
        {external && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              id={f('proxy-url')}
              label="Proxy URL"
              help={`Use host.docker.internal for a LiteLLM running on the same machine as ${PRODUCT_NAME}'s containers.`}
              problem={badScheme ? PROXY_URL_SCHEME_MESSAGE : undefined}
            >
              <input
                id={f('proxy-url')}
                type="url"
                inputMode="url"
                className={cx(inputBase, 'font-mono', badScheme && 'border-critical hover:border-critical')}
                placeholder={PROXY_URL_PLACEHOLDER}
                value={form.proxy.url}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={badScheme ? true : undefined}
                aria-describedby={`${f('proxy-url')}-help`}
                onChange={(e) => setProxy({ url: e.target.value })}
              />
            </Field>
            <Field
              id={f('proxy-key')}
              label="API key"
              help="The master key of your proxy. It is stored on the server and never shown again."
              aside={
                <Badge tone={saved.proxy.has_key ? 'green' : 'neutral'} dot>
                  {saved.proxy.has_key ? 'Key set' : 'No key'}
                </Badge>
              }
            >
              <input
                id={f('proxy-key')}
                type="password"
                className={cx(inputBase, 'font-mono')}
                placeholder={saved.proxy.has_key ? 'Leave blank to keep the saved key' : 'Master key of your proxy'}
                value={form.proxy.api_key}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-describedby={`${f('proxy-key')}-help`}
                onChange={(e) => setProxy({ api_key: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Card>

      <Card icon={Brain} title="Which model does what" description="The names are the ones the proxy offers; the same model can do more than one job.">
        {!reachable && (
          <Notice tone="warning" className="mb-4">
            {MODEL_LIST_UNAVAILABLE_MESSAGE}
          </Notice>
        )}
        {staleList && (
          <p className="mb-4 flex items-center gap-2 text-xs text-ink-3">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            {STALE_MODEL_LIST_MESSAGE}
          </p>
        )}
        <div className="divide-y divide-hairline">
          {JOBS.map((row) => {
            const id = f(row.job);
            const chatJob = row.job !== 'embedding';
            const offline = !chatJob && form.embedding_provider === 'hash';
            return (
              <ModelRow key={row.job} id={id} label={row.label} hint={row.hint}>
                {!offline && (
                  <ModelControl
                    id={id}
                    value={form.models[row.job]}
                    options={optionsFor(saved.available_models, row.mode, form.models[row.job])}
                    typed={typedModels}
                    disabled={busy || (chatJob && !form.enabled)}
                    invalid={parsed.problems.models.includes(row.job)}
                    onChange={(value) => setModel(row.job, value)}
                  />
                )}
                {!chatJob && (
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                    <input
                      type="checkbox"
                      className={checkboxBase}
                      checked={offline}
                      disabled={busy}
                      onChange={(e) => edit((prev) => ({ ...prev, embedding_provider: e.target.checked ? 'hash' : 'litellm' }))}
                    />
                    Offline, no AI
                  </label>
                )}
              </ModelRow>
            );
          })}
        </div>
      </Card>

      <Card icon={SlidersHorizontal} title="Fine-tuning" description="The thresholds behind those jobs. The defaults suit most households.">
        <details onToggle={(e) => setTuningOpen(e.currentTarget.open)}>
          <summary
            className={cx(
              'inline-flex cursor-pointer select-none list-none items-center gap-1.5 rounded text-sm font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden',
              focusRing,
            )}
          >
            {tuningOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            {tuningOpen ? 'Hide fine-tuning' : 'Show fine-tuning'}
          </summary>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <Field
              id={f('similarity')}
              label="Memory confidence"
              help={`Below this, ${PRODUCT_NAME} asks the AI instead of trusting a remembered merchant.`}
              problem={problem('similarity')}
              readout={similarityReadout}
            >
              <input
                id={f('similarity')}
                type="range"
                min={THRESHOLDS.similarity.min}
                max={THRESHOLDS.similarity.max}
                step={1}
                value={form.thresholds.similarity}
                disabled={busy}
                aria-valuetext={similarityReadout}
                aria-describedby={`${f('similarity')}-help`}
                className="block w-full accent-brand"
                onChange={(e) => setThreshold('similarity', e.target.value)}
              />
            </Field>
            <Field
              id={f('top-k')}
              label="Examples shown to the AI"
              help="Remembered merchants shown alongside a new one so the answer matches your habits."
              problem={problem('top_k')}
              readout={plural(Number(form.thresholds.top_k) || 0, 'example')}
            >
              <input
                id={f('top-k')}
                type="number"
                inputMode="numeric"
                min={THRESHOLDS.top_k.min}
                max={THRESHOLDS.top_k.max}
                step={1}
                value={form.thresholds.top_k}
                disabled={busy}
                aria-invalid={problem('top_k') ? true : undefined}
                aria-describedby={`${f('top-k')}-help`}
                className={cx(inputBase, 'tabular sm:w-32')}
                onChange={(e) => setThreshold('top_k', e.target.value)}
              />
            </Field>
            <Field
              id={f('deviation')}
              label="Flag a bill when it moves more than"
              help="The monthly summary points out a regular merchant whose total moved by more than this."
              problem={problem('deviation')}
              readout={`${form.thresholds.deviation}%`}
            >
              <div className="flex items-center gap-2">
                <input
                  id={f('deviation')}
                  type="number"
                  inputMode="numeric"
                  min={THRESHOLDS.deviation.min}
                  max={THRESHOLDS.deviation.max}
                  step={1}
                  value={form.thresholds.deviation}
                  disabled={busy}
                  aria-invalid={problem('deviation') ? true : undefined}
                  aria-describedby={`${f('deviation')}-help`}
                  className={cx(inputBase, 'tabular sm:w-32')}
                  onChange={(e) => setThreshold('deviation', e.target.value)}
                />
                <span className="text-sm text-ink-2">%</span>
              </div>
            </Field>
            <Field
              id={f('lookback')}
              label="Months of history to compare"
              help="How far back the summary looks for what a bill usually costs."
              problem={problem('lookback')}
              readout={plural(Number(form.thresholds.lookback) || 0, 'month')}
            >
              <input
                id={f('lookback')}
                type="number"
                inputMode="numeric"
                min={THRESHOLDS.lookback.min}
                max={THRESHOLDS.lookback.max}
                step={1}
                value={form.thresholds.lookback}
                disabled={busy}
                aria-invalid={problem('lookback') ? true : undefined}
                aria-describedby={`${f('lookback')}-help`}
                className={cx(inputBase, 'tabular sm:w-32')}
                onChange={(e) => setThreshold('lookback', e.target.value)}
              />
            </Field>
          </div>
        </details>
      </Card>

      <div className="space-y-3">
        {showGuard && (
          <Notice
            tone="warning"
            actions={
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className={checkboxBase}
                  checked={clearMemory}
                  disabled={busy}
                  onChange={(e) => setClearMemory(e.target.checked)}
                />
                Clear the merchant memory and switch
              </label>
            }
          >
            Changing how merchants are remembered resets the merchant memory
            {saved.memory_rows > 0 ? ` (${plural(saved.memory_rows, 'learnt merchant')})` : ''}. They will be learnt again as you
            approve transactions.
          </Notice>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnSecondary} onClick={test} disabled={busy || !valid}>
            <PlugZap className={cx('h-4 w-4', testing && 'animate-pulse')} aria-hidden="true" />
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button type="submit" className={btnPrimary} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
        <ErrorMessage message={saveError} onDismiss={() => setSaveError(null)} />
        {savedNotice && (
          <Notice tone="good" role="status">
            {SAVED_MESSAGE}
          </Notice>
        )}
        <ErrorMessage message={testError} onDismiss={() => setTestError(null)} />
        {results && (
          <div className={cardInset}>
            <p className={eyebrow}>Connection test</p>
            <ul aria-label="Connection test results" className="mt-2 space-y-2 text-sm">
              {JOBS.map((row) => (
                <TestLine key={row.job} job={row.job} result={results[row.job]} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="text-xs text-ink-3">
        API keys never appear here. They live in <code className="font-mono">.env</code> on the server and the list of models in{' '}
        <code className="font-mono">litellm/config.yaml</code>; after changing either, run{' '}
        <code className="font-mono">docker compose up -d litellm</code>.
      </p>
    </form>
  );
}

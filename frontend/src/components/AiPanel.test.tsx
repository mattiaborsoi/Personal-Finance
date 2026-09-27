import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AiSettings, AiTestResult, AiUpdate } from '../api';
import { aiSettings } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import {
  AiPanel,
  BUNDLED_PROXY_LABEL,
  MODEL_LIST_UNAVAILABLE_MESSAGE,
  NO_EMBEDDING_MODEL_MESSAGE,
  BUNDLED_PROXY_DOWN_MESSAGE,
  EXTERNAL_PROXY_LABEL,
  MODEL_BLANK_MESSAGE,
  PROXY_URL_BLANK_MESSAGE,
  PROXY_URL_PLACEHOLDER,
  PROXY_URL_SCHEME_MESSAGE,
  SAVED_MESSAGE,
  STALE_MODEL_LIST_MESSAGE,
} from './AiPanel';

const EXTERNAL_URL = 'http://host.docker.internal:4000';

/** What the server would store for a PUT body: the changed fields over the current document. */
function applyUpdate(current: AiSettings, body: AiUpdate): AiSettings {
  const proxy = { ...current.proxy };
  if (body.proxy?.mode) proxy.mode = body.proxy.mode;
  if (body.proxy?.url) proxy.url = body.proxy.url;
  if (body.proxy?.api_key) proxy.has_key = true;
  if (proxy.mode === 'bundled') proxy.url = current.proxy.bundled_url;
  return {
    ...current,
    enabled: body.enabled ?? current.enabled,
    embedding_provider: body.embedding_provider ?? current.embedding_provider,
    models: { ...current.models, ...body.models },
    thresholds: { ...current.thresholds, ...body.thresholds },
    proxy,
    memory_rows: body.clear_memory ? 0 : current.memory_rows,
    stored: true,
  };
}

/** GET answers the current document; a PUT stores the body and answers the result; POST /test answers `testResult`. */
function mockAi(initial: AiSettings, testResult?: AiTestResult) {
  let current = initial;
  return mockFetch(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/ai') return jsonResponse(current);
    if (method === 'PUT' && url === '/api/ai') {
      current = applyUpdate(current, body as AiUpdate);
      return jsonResponse(current);
    }
    if (method === 'POST' && url === '/api/ai/test' && testResult) return jsonResponse(testResult);
    return undefined;
  });
}

function byMethod(calls: RecordedCall[], method: string, url = '/api/ai'): RecordedCall[] {
  return calls.filter((c) => c.method === method && c.url === url);
}

function optionLabels(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
}

async function renderPanel() {
  renderWithProviders(<AiPanel />);
  return screen.findByRole('switch', { name: 'Use AI' });
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
const testButton = () => screen.getByRole('button', { name: 'Test connection' });

describe('<AiPanel />', () => {
  it('shows the saved setup: the switch, the badge, the tiles, each job’s model and the thresholds', async () => {
    const { calls } = mockAi(aiSettings());

    const toggle = await renderPanel();

    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
    expect(toggle).toBeChecked();
    const ai = screen.getByRole('region', { name: 'AI' });
    expect(within(ai).getByText('On')).toBeInTheDocument();
    expect(ai).toHaveTextContent('When off, Settl uses only your rules and the merchants it has already learnt.');
    expect(within(ai).getByText('Proxy reachable')).toBeInTheDocument();
    expect(within(ai).getByText('Yes')).toBeInTheDocument();
    expect(within(ai).getByText('http://litellm:4000')).toBeInTheDocument();
    expect(within(ai).getByText('Models available')).toBeInTheDocument();
    expect(within(ai).getByText('4')).toBeInTheDocument();
    expect(within(ai).getByText('Learnt merchants')).toBeInTheDocument();
    expect(within(ai).getByText('8')).toBeInTheDocument();
    expect(within(ai).queryByText(/Nothing saved yet/)).not.toBeInTheDocument();

    expect(screen.getByRole('radio', { name: BUNDLED_PROXY_LABEL })).toBeChecked();
    expect(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL })).not.toBeChecked();
    expect(screen.queryByLabelText('Proxy URL')).not.toBeInTheDocument();

    // Chat jobs offer the chat models and the one the proxy says nothing about; never the embedding model.
    const chat = screen.getByLabelText('Categorising transactions');
    expect(chat).toHaveValue('default-chat');
    expect(optionLabels(chat)).toEqual([
      'Anthropic · claude-opus-5 (default-chat)',
      'Anthropic · claude-haiku-4-5 (cheap-chat)',
      'local-anything',
    ]);
    expect(screen.getByLabelText('Reading awkward PDFs')).toHaveValue('default-chat');
    expect(screen.getByLabelText('Monthly summary')).toHaveValue('default-chat');
    const embedding = screen.getByLabelText('Merchant memory');
    expect(embedding).toHaveValue('default-embedding');
    expect(optionLabels(embedding)).toEqual(['OpenAI · text-embedding-3-small (default-embedding)', 'local-anything']);
    expect(screen.getByRole('checkbox', { name: 'Offline, no AI' })).not.toBeChecked();

    expect(screen.getByText('Show fine-tuning')).toBeInTheDocument();
    expect(screen.getByLabelText('Memory confidence')).toHaveValue('82');
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByLabelText('Examples shown to the AI')).toHaveValue(3);
    expect(screen.getByLabelText('Flag a bill when it moves more than')).toHaveValue(15);
    expect(screen.getByLabelText('Months of history to compare')).toHaveValue(3);

    expect(saveButton()).toBeDisabled();
    expect(testButton()).toBeEnabled();
    expect(screen.getByText(/API keys never appear here/)).toHaveTextContent('docker compose up -d litellm');
  });

  it('keeps a model the proxy no longer lists in its dropdown, and says when nothing has been saved yet', async () => {
    mockAi(aiSettings({ models: { ...aiSettings().models, audit: 'old-audit' }, stored: false }));

    await renderPanel();

    const audit = screen.getByLabelText('Monthly summary');
    expect(audit).toHaveValue('old-audit');
    expect(optionLabels(audit)[0]).toBe('old-audit (not listed by the proxy)');
    expect(screen.getByRole('region', { name: 'AI' })).toHaveTextContent('Nothing saved yet: these are the defaults from config.yaml and .env.');
  });

  it('switching AI off disables the three chat selects and Save sends only enabled:false', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(aiSettings());

    const toggle = await renderPanel();
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(within(screen.getByRole('region', { name: 'AI' })).getByText('Off')).toBeInTheDocument();
    expect(screen.getByLabelText('Categorising transactions')).toBeDisabled();
    expect(screen.getByLabelText('Reading awkward PDFs')).toBeDisabled();
    expect(screen.getByLabelText('Monthly summary')).toBeDisabled();
    expect(screen.getByLabelText('Merchant memory')).toBeEnabled();

    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ enabled: false });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(saveButton()).toBeDisabled();
    expect(screen.getByLabelText('Categorising transactions')).toBeDisabled();
  });

  it('choosing a different chat model sends only that model', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(aiSettings());

    await renderPanel();
    await user.selectOptions(screen.getByLabelText('Categorising transactions'), 'cheap-chat');
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ models: { chat: 'cheap-chat' } });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(screen.getByLabelText('Categorising transactions')).toHaveValue('cheap-chat');
  });

  it('guards a change of embedding model behind clearing the merchant memory', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(aiSettings());

    await renderPanel();
    await user.selectOptions(screen.getByLabelText('Merchant memory'), 'local-anything');

    expect(
      screen.getByText(
        'Changing how merchants are remembered resets the merchant memory (8 learnt merchants). They will be learnt again as you approve transactions.',
      ),
    ).toBeInTheDocument();
    // Save stays pressable; without the box ticked it points at the box instead of sending.
    const clear = screen.getByRole('checkbox', { name: 'Clear the merchant memory and switch' });
    await user.click(saveButton());
    expect(clear).toHaveFocus();
    expect(byMethod(calls, 'PUT')).toHaveLength(0);

    await user.click(clear);
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ models: { embedding: 'local-anything' }, clear_memory: true });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(screen.queryByText(/resets the merchant memory/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'AI' })).getByText('0')).toBeInTheDocument();
  });

  it('switches the merchant memory offline with embedding_provider:hash and hides the model select', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(aiSettings({ memory_rows: 0 }));

    await renderPanel();
    await user.click(screen.getByRole('checkbox', { name: 'Offline, no AI' }));

    expect(screen.queryByLabelText('Merchant memory')).not.toBeInTheDocument();
    // Nothing is remembered yet, so there is nothing to warn about.
    expect(screen.queryByText(/resets the merchant memory/)).not.toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ embedding_provider: 'hash' });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(screen.getByRole('checkbox', { name: 'Offline, no AI' })).toBeChecked();
  });

  it('shows the server’s 409 detail and then offers to clear the memory', async () => {
    const user = userEvent.setup();
    const detail = 'changing how merchants are remembered makes the existing merchant memory unusable; confirm clearing it to switch';
    let refused = false;
    const { calls } = mockFetch(({ method, url, body }) => {
      // The panel loaded before anything was learnt, so it does not expect a conflict.
      if (method === 'GET' && url === '/api/ai') return jsonResponse(aiSettings({ memory_rows: 0 }));
      if (method === 'PUT' && url === '/api/ai') {
        if ((body as AiUpdate).clear_memory) return jsonResponse(applyUpdate(aiSettings(), body as AiUpdate));
        refused = true;
        return jsonResponse({ detail }, 409);
      }
      return undefined;
    });

    await renderPanel();
    await user.selectOptions(screen.getByLabelText('Merchant memory'), 'local-anything');
    expect(screen.queryByText(/resets the merchant memory/)).not.toBeInTheDocument();
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(refused).toBe(true);
    expect(screen.getByText(/resets the merchant memory/)).toBeInTheDocument();
    await user.click(saveButton());
    expect(screen.getByRole('checkbox', { name: 'Clear the merchant memory and switch' })).toHaveFocus();
    expect(byMethod(calls, 'PUT')).toHaveLength(1);

    await user.click(screen.getByRole('checkbox', { name: 'Clear the merchant memory and switch' }));
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(2));
    expect(byMethod(calls, 'PUT')[1].body).toEqual({ models: { embedding: 'local-anything' }, clear_memory: true });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tests the connection with the values on the form and lists every result, failures and switched-off jobs included', async () => {
    const user = userEvent.setup();
    const result: AiTestResult = {
      chat: { ok: true, ms: 412, model: 'cheap-chat', error: null },
      extraction: null,
      audit: { ok: false, ms: null, model: 'default-chat', error: 'model not found: default-chat' },
      embedding: { ok: true, ms: 180, model: 'default-embedding', dimensions: 1536, error: null },
    };
    const { calls } = mockAi(aiSettings(), result);

    await renderPanel();
    await user.selectOptions(screen.getByLabelText('Categorising transactions'), 'cheap-chat');
    await user.click(testButton());

    const list = await screen.findByRole('list', { name: 'Connection test results' });
    expect(byMethod(calls, 'POST', '/api/ai/test')).toHaveLength(1);
    expect(byMethod(calls, 'POST', '/api/ai/test')[0].body).toEqual({
      enabled: true,
      embedding_provider: 'litellm',
      models: { chat: 'cheap-chat', extraction: 'default-chat', audit: 'default-chat', embedding: 'default-embedding' },
      thresholds: { similarity_threshold: 0.82, top_k: 3, deviation_threshold: 0.15, lookback_periods: 3 },
      proxy: { mode: 'bundled' },
    });
    // Testing never saves.
    expect(byMethod(calls, 'PUT')).toHaveLength(0);

    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Categorising · cheap-chat · 412 ms');
    expect(within(items[0]).getByRole('img', { name: 'OK' })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Reading PDFs · off');
    expect(within(items[1]).getByRole('img', { name: 'Off' })).toBeInTheDocument();
    expect(items[2]).toHaveTextContent('Monthly summary · default-chat');
    expect(items[2]).toHaveTextContent('model not found: default-chat');
    expect(within(items[2]).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(items[3]).toHaveTextContent('Merchant memory · default-embedding · 180 ms · 1536 dimensions');
    expect(within(items[3]).getByRole('img', { name: 'OK' })).toBeInTheDocument();
    expect(testButton()).toBeEnabled();
    expect(saveButton()).toBeEnabled();
  });

  it('shows a failed test request as an error', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/ai') return jsonResponse(aiSettings());
      if (method === 'POST' && url === '/api/ai/test') return jsonResponse({ detail: 'proxy timed out' }, 502);
      return undefined;
    });

    await renderPanel();
    await user.click(testButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('proxy timed out');
    expect(screen.queryByRole('list', { name: 'Connection test results' })).not.toBeInTheDocument();
  });

  it('falls back to typed model names when the proxy cannot be reached', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(
      aiSettings({ available_models: [], proxy: { ...aiSettings().proxy, reachable: false } }),
    );

    await renderPanel();

    expect(screen.getByText(MODEL_LIST_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    const ai = screen.getByRole('region', { name: 'AI' });
    expect(within(ai).getByText('No')).toBeInTheDocument();
    expect(within(ai).getByText('0')).toBeInTheDocument();
    const chat = screen.getByLabelText('Categorising transactions');
    expect(chat).toHaveAttribute('type', 'text');
    expect(chat).toHaveValue('default-chat');
    expect(screen.getByLabelText('Merchant memory')).toHaveAttribute('type', 'text');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    await user.clear(chat);
    expect(chat).toHaveAttribute('aria-invalid', 'true');
    expect(chat).toHaveAccessibleDescription(MODEL_BLANK_MESSAGE);
    // A blank name cannot be saved: Save moves focus to it instead.
    await user.click(saveButton());
    expect(chat).toHaveFocus();
    expect(byMethod(calls, 'PUT')).toHaveLength(0);
    await user.type(chat, 'my-chat');
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ models: { chat: 'my-chat' } });
  });

  it('sends fine-tuning changes as fractions, and refuses values outside their range', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(aiSettings());

    await renderPanel();
    await user.click(screen.getByText('Show fine-tuning'));
    expect(screen.getByText('Hide fine-tuning')).toBeInTheDocument();

    const confidence = screen.getByLabelText('Memory confidence');
    expect(confidence).toHaveAttribute('type', 'range');
    expect(confidence).toHaveAttribute('min', '50');
    expect(confidence).toHaveAttribute('max', '99');
    fireEvent.change(confidence, { target: { value: '90' } });
    expect(screen.getByText('90%')).toBeInTheDocument();

    const deviation = screen.getByLabelText('Flag a bill when it moves more than');
    await user.clear(deviation);
    await user.type(deviation, '25');

    const examples = screen.getByLabelText('Examples shown to the AI');
    await user.clear(examples);
    await user.type(examples, '50');
    expect(screen.getByText('Enter a whole number between 1 and 10.')).toBeInTheDocument();
    expect(examples).toHaveAttribute('aria-invalid', 'true');
    expect(testButton()).toBeDisabled();
    await user.click(saveButton());
    expect(examples).toHaveFocus();
    expect(byMethod(calls, 'PUT')).toHaveLength(0);

    await user.clear(examples);
    await user.type(examples, '5');
    expect(screen.queryByText('Enter a whole number between 1 and 10.')).not.toBeInTheDocument();
    expect(screen.getByText('5 examples')).toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({
      thresholds: { similarity_threshold: 0.9, top_k: 5, deviation_threshold: 0.25 },
    });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(screen.getByLabelText('Memory confidence')).toHaveValue('90');
    expect(saveButton()).toBeDisabled();
  });

  it('switches to the user’s own LiteLLM and sends its URL and key, never pre-filling the key', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(aiSettings());

    await renderPanel();
    await user.click(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL }));

    const url = screen.getByLabelText('Proxy URL');
    expect(url).toHaveValue('');
    expect(url).toHaveAttribute('placeholder', PROXY_URL_PLACEHOLDER);
    expect(screen.getByText(/Use host\.docker\.internal for a LiteLLM running on the same machine/)).toBeInTheDocument();
    const key = screen.getByLabelText('API key');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', 'Leave blank to keep the saved key');
    expect(screen.getByText('Key set')).toBeInTheDocument();
    // The models on screen came from the bundled proxy, so they are typed until the new one is saved.
    expect(screen.getByText(STALE_MODEL_LIST_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('Categorising transactions')).toHaveAttribute('type', 'text');
    // Without a URL there is nothing to save yet, but no complaint before Save is pressed.
    expect(testButton()).toBeDisabled();
    expect(url).not.toHaveAttribute('aria-invalid');
    await user.click(saveButton());
    expect(url).toHaveFocus();
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(url).toHaveAccessibleDescription(PROXY_URL_BLANK_MESSAGE);
    expect(byMethod(calls, 'PUT')).toHaveLength(0);

    await user.type(url, EXTERNAL_URL);
    await user.type(key, 'sk-test');
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ proxy: { mode: 'external', url: EXTERNAL_URL, api_key: 'sk-test' } });
    expect(await screen.findByRole('status')).toHaveTextContent(SAVED_MESSAGE);
    expect(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL })).toBeChecked();
    expect(screen.getByLabelText('Proxy URL')).toHaveValue(EXTERNAL_URL);
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.queryByText(STALE_MODEL_LIST_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Categorising transactions').tagName).toBe('SELECT');
    expect(within(screen.getByRole('region', { name: 'AI' })).getByText(EXTERNAL_URL)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('sends only the proxy fields that changed', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(
      aiSettings({
        proxy: { mode: 'external', url: EXTERNAL_URL, bundled_url: 'http://litellm:4000', env_url: null, reachable: true, has_key: false },
      }),
    );

    await renderPanel();
    expect(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL })).toBeChecked();
    expect(screen.getByLabelText('Proxy URL')).toHaveValue(EXTERNAL_URL);
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'Master key of your proxy…');
    expect(screen.getByText('No key')).toBeInTheDocument();
    expect(screen.queryByText(STALE_MODEL_LIST_MESSAGE)).not.toBeInTheDocument();

    // A key on its own.
    await user.type(screen.getByLabelText('API key'), 'sk-new');
    await user.click(saveButton());
    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ proxy: { api_key: 'sk-new' } });
    expect(await screen.findByText('Key set')).toBeInTheDocument();

    // Back to the bundled container: only the mode goes, never the URL or an empty key.
    await user.click(screen.getByRole('radio', { name: BUNDLED_PROXY_LABEL }));
    expect(screen.queryByLabelText('Proxy URL')).not.toBeInTheDocument();
    expect(screen.getByText(STALE_MODEL_LIST_MESSAGE)).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(2));
    expect(byMethod(calls, 'PUT')[1].body).toEqual({ proxy: { mode: 'bundled' } });
  });

  it('starts from the LiteLLM named in .env when LITELLM_URL is set', async () => {
    // The server defaults to the external proxy with that URL; the page shows it as such.
    mockAi(
      aiSettings({
        proxy: { mode: 'external', url: EXTERNAL_URL, bundled_url: 'http://litellm:4000', env_url: EXTERNAL_URL, reachable: true, has_key: true },
      }),
    );

    await renderPanel();

    const own = screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL });
    expect(own).toBeChecked();
    expect(own).toHaveAccessibleDescription(`Anywhere Settl's containers can reach; enter its URL and key below. .env suggests ${EXTERNAL_URL}.`);
    expect(screen.getByRole('radio', { name: BUNDLED_PROXY_LABEL })).toHaveAccessibleDescription(
      'The container that ships with Settl (docker compose, profile bundled-litellm), at http://litellm:4000. Provider keys go in .env.',
    );
    expect(screen.getByLabelText('Proxy URL')).toHaveValue(EXTERNAL_URL);
    // No bundled container to restart, so no advice to do so.
    expect(screen.queryByText(/docker compose up -d litellm/)).not.toBeInTheDocument();
    expect(screen.getByText(/Provider API keys never appear here/)).toHaveTextContent("Settl only holds the proxy's key");
    expect(saveButton()).toBeDisabled();
  });

  it('says what to do when the bundled LiteLLM is chosen but not running, and offers the .env proxy as the alternative', async () => {
    const user = userEvent.setup();
    const { calls } = mockAi(
      aiSettings({
        available_models: [],
        proxy: { mode: 'bundled', url: 'http://litellm:4000', bundled_url: 'http://litellm:4000', env_url: EXTERNAL_URL, reachable: false, has_key: true },
      }),
    );

    await renderPanel();

    expect(screen.getByRole('radio', { name: BUNDLED_PROXY_LABEL })).toBeChecked();
    const notice = screen.getByText(new RegExp(BUNDLED_PROXY_DOWN_MESSAGE.replace(/[.'()]/g, '\\$&')));
    expect(notice).toHaveTextContent('Set COMPOSE_PROFILES=bundled-litellm in .env and run docker compose up -d to start it, or choose a LiteLLM you already run.');

    // Switching to the other option pre-fills the URL .env suggests; the warning is about the bundled one only.
    await user.click(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL }));
    expect(screen.getByLabelText('Proxy URL')).toHaveValue(EXTERNAL_URL);
    expect(screen.queryByText(/not answering/)).not.toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ proxy: { mode: 'external', url: EXTERNAL_URL } });
  });

  it('keeps the merchant memory offline, and says why, when the proxy lists no embedding model', async () => {
    const user = userEvent.setup();
    const chatOnly = aiSettings().available_models.filter((m) => m.mode === 'chat');
    const { calls } = mockAi(aiSettings({ embedding_provider: 'hash', available_models: chatOnly, memory_rows: 0 }));

    await renderPanel();

    const offline = screen.getByRole('checkbox', { name: 'Offline, no AI' });
    expect(offline).toBeChecked();
    expect(offline).toBeDisabled();
    expect(offline).toHaveAccessibleDescription(NO_EMBEDDING_MODEL_MESSAGE);
    expect(screen.queryByLabelText('Merchant memory')).not.toBeInTheDocument();
    // The chat jobs are unaffected.
    await user.selectOptions(screen.getByLabelText('Categorising transactions'), 'cheap-chat');
    await user.click(saveButton());
    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ models: { chat: 'cheap-chat' } });
  });

  it('still lets the memory go offline when its saved model is one the proxy no longer lists', async () => {
    const user = userEvent.setup();
    const chatOnly = aiSettings().available_models.filter((m) => m.mode === 'chat');
    const { calls } = mockAi(aiSettings({ available_models: chatOnly, memory_rows: 0 }));

    await renderPanel();

    expect(screen.getByText(NO_EMBEDDING_MODEL_MESSAGE)).toBeInTheDocument();
    expect(optionLabels(screen.getByLabelText('Merchant memory'))).toEqual(['default-embedding (not listed by the proxy)']);
    const offline = screen.getByRole('checkbox', { name: 'Offline, no AI' });
    expect(offline).toBeEnabled();
    await user.click(offline);
    expect(offline).toBeDisabled();
    await user.click(saveButton());
    await waitFor(() => expect(byMethod(calls, 'PUT')).toHaveLength(1));
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ embedding_provider: 'hash' });
  });

  it('refuses a URL without a scheme and shows the server’s 422 for one it rejects', async () => {
    const user = userEvent.setup();
    const detail = 'proxy.url: could not connect to http://10.0.0.5:4000';
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/ai') return jsonResponse(aiSettings({ proxy: { ...aiSettings().proxy, has_key: false } }));
      if (method === 'PUT' && url === '/api/ai') return jsonResponse({ detail }, 422);
      return undefined;
    });

    await renderPanel();
    await user.click(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL }));
    const url = screen.getByLabelText('Proxy URL');
    await user.type(url, 'litellm:4000');

    expect(screen.getByText(PROXY_URL_SCHEME_MESSAGE)).toBeInTheDocument();
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(testButton()).toBeDisabled();
    await user.click(saveButton());
    expect(url).toHaveFocus();
    expect(byMethod(calls, 'PUT')).toHaveLength(0);

    await user.clear(url);
    await user.type(url, 'http://10.0.0.5:4000');
    expect(url).not.toHaveAttribute('aria-invalid');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(byMethod(calls, 'PUT')[0].body).toEqual({ proxy: { mode: 'external', url: 'http://10.0.0.5:4000' } });
    // What was typed is still there to correct.
    expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://10.0.0.5:4000');
    expect(saveButton()).toBeEnabled();
  });

  it('tests the connection through the proxy on the form, a freshly typed key included', async () => {
    const user = userEvent.setup();
    const result: AiTestResult = {
      chat: { ok: true, ms: 300, model: 'default-chat', error: null },
      extraction: { ok: true, ms: 310, model: 'default-chat', error: null },
      audit: { ok: true, ms: 320, model: 'default-chat', error: null },
      embedding: { ok: false, ms: 150, model: 'default-embedding', dimensions: 768, error: 'returned 768 dimensions, expected 1536' },
    };
    const { calls } = mockAi(aiSettings(), result);

    await renderPanel();
    await user.click(screen.getByRole('radio', { name: EXTERNAL_PROXY_LABEL }));
    await user.type(screen.getByLabelText('Proxy URL'), EXTERNAL_URL);
    await user.type(screen.getByLabelText('API key'), 'sk-test');
    await user.click(testButton());

    const list = await screen.findByRole('list', { name: 'Connection test results' });
    expect(byMethod(calls, 'POST', '/api/ai/test')[0].body).toMatchObject({
      proxy: { mode: 'external', url: EXTERNAL_URL, api_key: 'sk-test' },
    });
    expect(byMethod(calls, 'PUT')).toHaveLength(0);
    const embedding = within(list).getAllByRole('listitem')[3];
    expect(embedding).toHaveTextContent('Merchant memory · default-embedding · 150 ms · 768 dimensions');
    expect(embedding).toHaveTextContent('returned 768 dimensions, expected 1536');
    expect(within(embedding).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
  });

  it('shows a load error with a retry that fetches again', async () => {
    const user = userEvent.setup();
    let failed = false;
    const { calls } = mockFetch(({ method, url }) => {
      if (method !== 'GET' || url !== '/api/ai') return undefined;
      if (failed) return jsonResponse(aiSettings());
      failed = true;
      return jsonResponse({ detail: 'database unavailable' }, 500);
    });

    renderWithProviders(<AiPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('switch', { name: 'Use AI' })).toBeChecked();
    expect(byMethod(calls, 'GET')).toHaveLength(2);
  });
});

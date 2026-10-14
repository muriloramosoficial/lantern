'use strict';

/* Lantern renderer. Talks to the main process only through window.lantern. */

const api = window.lantern;

const PRESETS = [
  { label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { label: 'Mistral', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1' },
  { label: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' },
  { label: 'Together', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' },
  { label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { label: 'Ollama (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:1234/v1' },
  { label: 'llama.cpp (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:8080/v1' },
  { label: 'vLLM (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:8000/v1' },
];

const state = {
  info: null,
  settings: null,
  kinds: [],
  tree: null,
  attachments: new Set(),
  history: [],
  streaming: false,
  editingId: null,
  liveNode: null,
  liveText: '',
  pendingRender: false,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ utils */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Small markdown subset: fenced code, inline code, bold and plain links. */
function renderMarkdown(text) {
  const blocks = [];
  let out = escapeHtml(text || '');

  out = out.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '';
    blocks.push(`<pre>${label}<code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(
    /(https?:\/\/[^\s<)]+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>',
  );

  return out.replace(/\u0000(\d+)\u0000/g, (_match, index) => blocks[Number(index)] || '');
}

function setStatus(node, message, kind = '') {
  node.textContent = message || '';
  node.className = `status ${kind}`.trim();
}

function formatTokens(usage) {
  if (!usage) return '';
  const total = usage.total_tokens || usage.output_tokens || usage.completion_tokens;
  return total ? ` · ${total} tokens` : '';
}

/* -------------------------------------------------------- welcome + chat */

function showWelcome() {
  const messages = $('messages');
  if (state.history.length) return;
  messages.innerHTML = `
    <div class="welcome">
      <h1>Lantern</h1>
      <p>A local-first workbench for the models you already use. No account, no license server,
      no telemetry — your keys and conversations stay on this machine.</p>
      <ol>
        <li>Open <strong>Settings</strong> and add an endpoint (hosted API or a local server).</li>
        <li>Pick a <strong>workspace folder</strong> to give the model real files to look at.</li>
        <li>Tick the files you want as context and send your first message.</li>
      </ol>
    </div>`;
}

function appendMessage(role, text, { meta = '', error = false } = {}) {
  const messages = $('messages');
  const welcome = messages.querySelector('.welcome');
  if (welcome) welcome.remove();

  const node = document.createElement('div');
  node.className = `msg ${role}${error ? ' error' : ''}`;
  node.innerHTML = `
    <div class="msg-head"><span>${role === 'user' ? 'You' : 'Lantern'}</span>
      <button class="link copy" type="button">copy</button></div>
    <div class="body"></div>
    <div class="meta"></div>`;
  node.querySelector('.body').innerHTML = renderMarkdown(text);
  node.querySelector('.meta').textContent = meta;
  node.querySelector('.copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.liveNode === node ? state.liveText : node.querySelector('.body').innerText);
    setStatus($('status'), 'Copied to clipboard.');
  });

  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function scheduleLiveRender() {
  if (state.pendingRender) return;
  state.pendingRender = true;
  requestAnimationFrame(() => {
    state.pendingRender = false;
    if (!state.liveNode) return;
    state.liveNode.querySelector('.body').innerHTML = `${renderMarkdown(state.liveText)}<span class="cursor"></span>`;
    const messages = $('messages');
    messages.scrollTop = messages.scrollHeight;
  });
}

/* ----------------------------------------------------------- send / stop */

async function sendMessage(prompt) {
  if (state.streaming) return;
  const provider = state.settings?.providers.find((row) => row.active);

  if (!provider) {
    appendMessage('assistant', 'No provider configured yet. Open **Settings** and add your endpoint first.', { error: true });
    return;
  }

  state.history.push({ role: 'user', content: prompt });
  appendMessage('user', prompt, {
    meta: state.attachments.size ? `${state.attachments.size} file(s) attached` : '',
  });

  state.streaming = true;
  state.liveText = '';
  const assistantNode = appendMessage('assistant', '', { meta: `${provider.name} · ${provider.model}` });
  state.liveNode = assistantNode;
  assistantNode.querySelector('.body').innerHTML = '<span class="cursor"></span>';

  $('sendBtn').disabled = true;
  $('stopBtn').hidden = false;
  setStatus($('status'), `Streaming from ${provider.name}…`);

  const payload = {
    providerId: provider.id,
    messages: state.history.map((m) => ({ role: m.role, content: m.content })),
    attachments: [...state.attachments],
    systemPrompt: $('useSystemPrompt').checked ? $('systemPrompt').value.trim() : '',
  };

  const unsubscribe = api.chat.onDelta((delta) => {
    state.liveText += delta.text || '';
    scheduleLiveRender();
  });

  try {
    const result = await api.chat.send(payload);
    unsubscribe();

    if (!result.ok) {
      if (result.aborted) {
        assistantNode.querySelector('.body').innerHTML = renderMarkdown(`${state.liveText}\n\n_(stopped)_`);
        state.history.push({ role: 'assistant', content: state.liveText });
        setStatus($('status'), 'Stopped.');
      } else {
        assistantNode.remove();
        const detail = result.detail ? `\n\n\`\`\`\n${result.detail}\n\`\`\`` : '';
        appendMessage('assistant', `**Request failed:** ${result.error}${detail}`, { error: true });
        setStatus($('status'), result.error, 'error');
        state.history.pop();
      }
      return;
    }

    state.liveText = result.text;
    assistantNode.querySelector('.body').innerHTML = renderMarkdown(result.text);
    assistantNode.querySelector('.meta').textContent = [
      provider.name,
      `${result.ms} ms`,
      result.usage ? `${result.usage.total_tokens || result.usage.output_tokens || ''} tokens`.trim() : '',
      result.attached.length ? `context: ${result.attached.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    state.history.push({ role: 'assistant', content: result.text });
    setStatus($('status'), 'Done.' + formatTokens(result.usage), 'ok');
    if (result.contextNotes?.length) {
      appendMessage('assistant', `Context notes: ${result.contextNotes.join('; ')}`, {});
    }
  } catch (error) {
    unsubscribe();
    setStatus($('status'), error.message, 'error');
  } finally {
    state.streaming = false;
    state.liveNode = null;
    $('sendBtn').disabled = false;
    $('stopBtn').hidden = true;
  }
}

/* --------------------------------------------------------------- sidebar */

function renderTree() {
  const tree = $('tree');
  tree.innerHTML = '';
  if (!state.tree || !state.tree.entries.length) {
    tree.innerHTML = `<p class="empty">${state.settings?.workspace ? 'No readable files here.' : 'Select a folder to browse files.'}</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of state.tree.entries) {
    const depth = entry.path.split('/').length - 1;
    const row = document.createElement('label');
    row.className = 'node';
    row.style.paddingLeft = `${4 + depth * 12}px`;

    if (entry.type === 'dir') {
      row.innerHTML = `<span class="dir">${escapeHtml(entry.path.split('/').pop())}/</span>`;
    } else {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.attachments.has(entry.path);
      box.addEventListener('change', () => {
        if (box.checked) state.attachments.add(entry.path);
        else state.attachments.delete(entry.path);
        updateAttachSummary();
      });
      row.appendChild(box);
      const name = document.createElement('span');
      name.textContent = entry.path.split('/').pop();
      row.appendChild(name);
      if (entry.size > 200 * 1024) {
        const big = document.createElement('span');
        big.className = 'dir';
        big.textContent = ` ${Math.round(entry.size / 1024)} kB`;
        row.appendChild(big);
      }
    }
    fragment.appendChild(row);
  }
  tree.appendChild(fragment);
}

function updateAttachSummary() {
  $('attachCount').textContent = `${state.attachments.size} file${state.attachments.size === 1 ? '' : 's'} attached`;
}

async function loadWorkspace() {
  $('workspacePath').textContent = state.settings.workspace || 'No folder selected.';
  if (!state.settings.workspace) {
    state.tree = null;
    renderTree();
    return;
  }
  const result = await api.workspace.list();
  if (!result.ok) {
    setStatus($('status'), result.error, 'error');
    state.tree = null;
  } else {
    state.tree = result.tree;
  }
  renderTree();
  updateAttachSummary();
}

/* ------------------------------------------------------------- providers */

function renderProviderSelect() {
  const select = $('providerSelect');
  select.innerHTML = '';
  const rows = state.settings.providers;
  if (!rows.length) {
    const option = document.createElement('option');
    option.textContent = 'no provider yet';
    option.value = '';
    select.appendChild(option);
    return;
  }
  for (const provider of rows) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.name} — ${provider.model}`;
    option.selected = provider.active;
    select.appendChild(option);
  }
}

function renderProviderList() {
  const list = $('providerList');
  list.innerHTML = '';
  if (!state.settings.providers.length) {
    list.innerHTML = '<li class="hint">Nothing configured yet.</li>';
    return;
  }
  for (const provider of state.settings.providers) {
    const item = document.createElement('li');
    item.className = `provider-item${provider.active ? ' active' : ''}${provider.id === state.editingId ? ' editing' : ''}`;
    item.innerHTML = `
      <div class="grow">
        <div class="name">${escapeHtml(provider.name)}${provider.active ? ' ★' : ''}</div>
        <div class="sub">${escapeHtml(provider.kindLabel)} · ${escapeHtml(provider.model)}${
          provider.hasKey ? '' : ' · no key'
        }</div>
      </div>
      <button class="btn tiny activate" type="button">${provider.active ? 'active' : 'use'}</button>`;

    item.addEventListener('click', () => loadProviderForm(provider.id));
    item.querySelector('.activate').addEventListener('click', async (event) => {
      event.stopPropagation();
      await api.providers.activate(provider.id);
      await refreshSettings();
      setStatus($('providerStatus'), `${provider.name} is now the active provider.`, 'ok');
    });
    list.appendChild(item);
  }
}

function currentFormValues() {
  let extraHeaders = {};
  const raw = $('fHeaders').value.trim();
  if (raw) extraHeaders = JSON.parse(raw);
  const temperature = $('fTemperature').value.trim();

  return {
    name: $('fName').value.trim(),
    kind: $('fKind').value,
    baseUrl: $('fBaseUrl').value.trim(),
    apiPath: $('fApiPath').value.trim(),
    model: $('fModel').value.trim(),
    maxTokens: Number($('fMaxTokens').value) || 4096,
    temperature: temperature ? Number(temperature) : null,
    stream: $('fStream').checked,
    extraHeaders,
    apiKey: $('fApiKey').value,
  };
}

function fillForm(values, { keepKey = false } = {}) {
  $('fName').value = values.name || '';
  $('fKind').value = values.kind || 'openai-compatible';
  $('fBaseUrl').value = values.baseUrl || '';
  $('fApiPath').value = values.apiPath || '';
  $('fModel').value = values.model || '';
  $('fMaxTokens').value = values.maxTokens || 4096;
  $('fTemperature').value = values.temperature ?? '';
  $('fStream').checked = values.stream !== false;
  $('fHeaders').value = values.extraHeaders && Object.keys(values.extraHeaders).length
    ? JSON.stringify(values.extraHeaders, null, 2)
    : '';
  if (!keepKey) $('fApiKey').value = values.apiKey || '';
}

function newProviderForm() {
  state.editingId = null;
  $('formTitle').textContent = 'New provider';
  $('deleteProvider').hidden = true;
  fillForm({ kind: 'openai-compatible', maxTokens: 4096, stream: true });
  $('fApiPath').placeholder = '/chat/completions';
  setStatus($('providerStatus'), '');
  renderProviderList();
}

async function loadProviderForm(id) {
  const provider = state.settings.providers.find((row) => row.id === id);
  if (!provider) return newProviderForm();
  state.editingId = id;
  $('formTitle').textContent = `Editing ${provider.name}`;
  $('deleteProvider').hidden = false;
  fillForm(provider);
  $('fApiKey').placeholder = provider.hasKey ? 'leave empty to keep the saved key' : 'no key saved';
  setStatus($('providerStatus'), '');
  renderProviderList();
}

async function saveProviderForm() {
  let values;
  try {
    values = currentFormValues();
  } catch (error) {
    setStatus($('providerStatus'), `Extra headers must be valid JSON (${error.message}).`, 'error');
    return;
  }

  const result = state.editingId
    ? await api.providers.update(state.editingId, {
        ...values,
        apiKey: values.apiKey ? values.apiKey : undefined,
      })
    : await api.providers.add(values);

  if (!result.ok) {
    setStatus($('providerStatus'), result.errors.join(' '), 'error');
    return;
  }

  setStatus($('providerStatus'), `Saved "${result.provider.name}".`, 'ok');
  state.editingId = result.provider.id;
  await refreshSettings();
  await loadProviderForm(result.provider.id);
  $('fApiKey').value = '';
}

async function testProviderForm() {
  setStatus($('providerStatus'), 'Testing…');
  let payload;
  if (state.editingId && !$('fApiKey').value) {
    payload = { id: state.editingId };
  } else {
    try {
      payload = { draft: currentFormValues() };
    } catch (error) {
      setStatus($('providerStatus'), `Fix the JSON headers first (${error.message}).`, 'error');
      return;
    }
  }

  const result = await api.providers.test(payload);
  if (result.ok) {
    setStatus($('providerStatus'), `OK in ${result.latencyMs} ms — reply: "${result.reply.trim() || '(empty)'}"`, 'ok');
  } else {
    setStatus(
      $('providerStatus'),
      `Failed${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error}${result.detail ? ` — ${result.detail}` : ''}`,
      'error',
    );
  }
}

async function fetchModels() {
  if (!state.editingId) {
    setStatus($('providerStatus'), 'Save the provider first, then list its models.', 'error');
    return;
  }
  setStatus($('providerStatus'), 'Asking the endpoint for its models…');
  const result = await api.providers.models(state.editingId);
  if (!result.ok) {
    setStatus($('providerStatus'), `Could not list models: ${result.error}`, 'error');
    return;
  }
  const list = $('modelList');
  list.innerHTML = '';
  for (const model of result.models) {
    const option = document.createElement('option');
    option.value = model;
    list.appendChild(option);
  }
  setStatus($('providerStatus'), `${result.models.length} model(s) available — start typing in the model field.`, 'ok');
}

async function deleteProviderForm() {
  if (!state.editingId) return;
  await api.providers.remove(state.editingId);
  setStatus($('providerStatus'), 'Provider removed.', 'ok');
  state.editingId = null;
  await refreshSettings();
  newProviderForm();
}

function renderPresets() {
  const box = $('presets');
  box.innerHTML = '';
  for (const preset of PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = preset.label;
    chip.addEventListener('click', () => {
      $('fKind').value = preset.kind;
      $('fBaseUrl').value = preset.baseUrl;
      $('fApiPath').value = '';
      if (!$('fName').value) $('fName').value = preset.label;
      setStatus($('providerStatus'), `${preset.label} endpoint filled in — set the model, and the key if it needs one.`);
    });
    box.appendChild(chip);
  }
}

/* ------------------------------------------------------------------ boot */

async function refreshSettings() {
  state.settings = await api.settings.get();
  renderProviderSelect();
  renderProviderList();
  $('workspacePath').textContent = state.settings.workspace || 'No folder selected.';
  $('keyStorageInfo').textContent = state.settings.keyStorageSecure
    ? `keys sealed with the OS keychain (${state.settings.keyStorage})`
    : 'keys stored in plain text in the app settings file';
  $('keyHint').textContent = state.settings.keyStorageSecure
    ? 'stored locally, encrypted with your OS keychain'
    : 'stored locally in plain text (OS keychain unavailable)';
}

function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

async function boot() {
  state.info = await api.info();
  $('versionInfo').textContent = `Lantern ${state.info.version} · Electron ${state.info.electron} · Node ${state.info.node}`;

  state.kinds = await api.providers.kinds();
  const kindSelect = $('fKind');
  kindSelect.innerHTML = '';
  for (const kind of state.kinds) {
    const option = document.createElement('option');
    option.value = kind.id;
    option.textContent = `${kind.label} — ${kind.hint}`;
    kindSelect.appendChild(option);
  }

  await refreshSettings();

  const savedTheme = state.settings.ui?.theme || 'system';
  const resolved = applyTheme(savedTheme);
  $('themeToggle').textContent = resolved === 'light' ? '☾' : '☀';

  renderPresets();
  newProviderForm();
  updateAttachSummary();
  await loadWorkspace();
  showWelcome();

  if (!state.settings.providers.length) {
    $('settingsDialog').showModal();
  }

  window.__lanternReady = true;
}

/* --------------------------------------------------------------- events */

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  $('prompt').value = '';
  sendMessage(prompt);
});

$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('stopBtn').addEventListener('click', async () => {
  await api.chat.abort();
  setStatus($('status'), 'Stopping…');
});

$('useSystemPrompt').addEventListener('change', (event) => {
  $('systemPrompt').hidden = !event.target.checked;
  if (event.target.checked) $('systemPrompt').focus();
});

$('chooseWorkspace').addEventListener('click', async () => {
  const result = await api.workspace.choose();
  if (!result.ok) return;
  state.attachments.clear();
  await refreshSettings();
  await loadWorkspace();
});

$('clearAttachments').addEventListener('click', () => {
  state.attachments.clear();
  renderTree();
  updateAttachSummary();
});

$('openSettings').addEventListener('click', () => {
  $('settingsDialog').showModal();
});

$('themeToggle').addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  $('themeToggle').textContent = next === 'light' ? '☾' : '☀';
  await api.settings.setUi({ theme: next });
});

$('providerSelect').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id) return;
  await api.providers.activate(id);
  await refreshSettings();
});

$('newProvider').addEventListener('click', newProviderForm);
$('saveProvider').addEventListener('click', saveProviderForm);
$('testProvider').addEventListener('click', testProviderForm);
$('deleteProvider').addEventListener('click', deleteProviderForm);
$('fetchModels').addEventListener('click', fetchModels);

$('fKind').addEventListener('change', (event) => {
  const kind = state.kinds.find((row) => row.id === event.target.value);
  if (!kind) return;
  $('fApiPath').placeholder = kind.defaultPath;
  if (!$('fBaseUrl').value) $('fBaseUrl').value = kind.defaultBaseUrl;
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((state.settings?.ui?.theme || 'system') === 'system') applyTheme('system');
});

window.addEventListener('unhandledrejection', (event) => {
  setStatus($('status'), `Unexpected error: ${event.reason?.message || event.reason}`, 'error');
});

boot().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#ff9c9c">Lantern failed to start:\n${escapeHtml(error.stack || error.message)}</pre>`;
});

'use strict';

/*
  Lantern renderer — the workbench shell.

  Everything here runs in a sandboxed page with no Node access: all privileged
  work goes through the narrow API exposed on window.lantern by the preload
  bridge. Tasks are kept in localStorage (still on this machine, inside the
  app's own profile) and never leave it except as the messages you send to the
  endpoint you configured.
*/

const api = window.lantern;
const STORAGE_KEY = 'lantern.tasks.v1';
const MAX_TASKS = 40;
const MAX_MESSAGE_CHARS = 40_000;

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
  tasks: [],
  activeTaskId: null,
  maximizedTaskId: null,
  editingProviderId: null,
  stream: null,
  drafts: {},
  palette: { open: false, items: [], index: 0 },
};

const $ = (id) => document.getElementById(id);
const uid = () => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/* ──────────────────────────────────────────────────────────── utilities ── */

const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Fenced code, inline code, bold and bare links. */
function renderMarkdown(text) {
  const blocks = [];
  let out = escapeHtml(text);

  out = out.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '';
    blocks.push(`<pre>${label}<code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] || '');
}

function setStatus(message, kind = '') {
  const node = $('statusText');
  node.textContent = message || '';
  node.className = `status-text ${kind}`.trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function titleFrom(prompt) {
  const firstLine = prompt.split('\n').find((line) => line.trim()) || 'New task';
  return truncate(firstLine.trim().replace(/\s+/g, ' '), 46);
}

/* ─────────────────────────────────────────────────────────── task model ── */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((task) => task && typeof task.id === 'string')
      .map((task) => ({
        id: task.id,
        title: String(task.title || 'New task'),
        status: task.status === 'running' ? 'idle' : task.status || 'idle',
        createdAt: task.createdAt || Date.now(),
        messages: Array.isArray(task.messages)
          ? task.messages.map((m) => ({ ...m, content: truncate(String(m.content || ''), MAX_MESSAGE_CHARS) }))
          : [],
      }))
      .slice(0, MAX_TASKS);
  } catch {
    return [];
  }
}

function saveTasks() {
  try {
    const payload = state.tasks.slice(0, MAX_TASKS).map((task) => ({
      ...task,
      messages: task.messages.map((m) => ({ ...m, content: truncate(m.content, MAX_MESSAGE_CHARS) })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    setStatus('Could not persist tasks locally.', 'error');
  }
}

function createTask({ title = 'New task', silent = false } = {}) {
  const task = { id: uid(), title, status: 'idle', createdAt: Date.now(), messages: [] };
  state.tasks.unshift(task);
  state.activeTaskId = task.id;
  saveTasks();
  renderAll();
  if (!silent) $('prompt-' + task.id)?.focus();
  return task;
}

function activeTask() {
  return state.tasks.find((task) => task.id === state.activeTaskId) || null;
}

function removeTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  if (state.activeTaskId === id) state.activeTaskId = state.tasks[0] ? state.tasks[0].id : null;
  if (state.maximizedTaskId === id) state.maximizedTaskId = null;
  saveTasks();
  renderAll();
}

/* ─────────────────────────────────────────────────────────────── sending ── */

async function sendPrompt(taskId, prompt) {
  const task = state.tasks.find((row) => row.id === taskId);
  if (!task || state.stream) return;

  const provider = state.settings.providers.find((row) => row.active);
  if (!provider) {
    task.messages.push({
      role: 'assistant',
      content: 'No provider configured yet. Open **Settings** and add your endpoint first.',
      error: true,
    });
    task.status = 'error';
    saveTasks();
    renderAll();
    return;
  }

  if (task.messages.length === 0) task.title = titleFrom(prompt);
  task.messages.push({
    role: 'user',
    content: prompt,
    attached: [...state.attachments],
  });
  task.status = 'running';
  state.activeTaskId = taskId;
  saveTasks();
  renderAll();

  const assistantMessage = { role: 'assistant', content: '', meta: `${provider.name} · ${provider.model}`, streaming: true };
  task.messages.push(assistantMessage);

  state.stream = { taskId, index: task.messages.length - 1, text: '' };
  renderAll();
  patchStreamingMessage(taskId);

  const unsubscribe = api.chat.onDelta((delta) => {
    if (!state.stream || state.stream.taskId !== taskId) return;
    state.stream.text += delta.text || '';
    patchStreamingMessage(taskId);
  });

  try {
    const result = await api.chat.send({
      providerId: provider.id,
      messages: task.messages
        .filter((m) => !m.streaming && !m.error)
        .map((m) => ({ role: m.role, content: m.content })),
      attachments: [...state.attachments],
    });

    if (!result.ok) {
      if (result.aborted) {
        assistantMessage.content = `${state.stream.text}\n\n_(stopped)_`;
        assistantMessage.meta = 'stopped';
        task.status = 'idle';
      } else {
        task.messages.pop();
        task.messages.push({
          role: 'assistant',
          content: `**Request failed:** ${result.error}${result.detail ? `\n\n\`\`\`\n${result.detail}\n\`\`\`` : ''}`,
          error: true,
        });
        task.status = 'error';
        setStatus(result.error, 'error');
      }
    } else {
      assistantMessage.content = result.text;
      assistantMessage.streaming = false;
      assistantMessage.attached = result.attached || [];
      assistantMessage.meta = [
        provider.name,
        `${result.ms} ms`,
        result.usage ? `${result.usage.total_tokens || result.usage.output_tokens || ''} tokens` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      task.status = 'done';
      setStatus(`Answered by ${provider.name} in ${result.ms} ms.`, 'ok');
    }
  } catch (error) {
    task.messages.pop();
    task.status = 'error';
    setStatus(error.message, 'error');
  } finally {
    unsubscribe();
    state.stream = null;
    saveTasks();
    renderAll();
  }
}

function patchStreamingMessage(taskId) {
  const node = document.querySelector(`[data-stream="${taskId}"]`);
  if (!node || !state.stream) return;
  node.innerHTML = `${renderMarkdown(state.stream.text)}<span class="cursor"></span>`;
  node.closest('.tile-body')?.scrollTo({ top: node.closest('.tile-body').scrollHeight });
}

/* ──────────────────────────────────────────────────────────── rendering ── */

function renderAll() {
  // Re-rendering rebuilds the tiles, so remember where the caret was and put
  // it back: a half-typed prompt must survive a streaming update.
  const previous = document.activeElement;
  const focusedId = previous && typeof previous.id === 'string' && previous.id.startsWith('prompt-') ? previous.id : null;
  const caret = focusedId ? previous.selectionStart : null;

  renderTaskList();
  renderTiles();
  renderProviderSelect();
  renderAttachSummary();
  updateEmptyState();

  if (focusedId) {
    const node = document.getElementById(focusedId);
    if (node) {
      node.focus();
      if (caret !== null) node.setSelectionRange(caret, caret);
    }
  }
}

function updateEmptyState() {
  const hasTasks = state.tasks.length > 0;
  $('emptyState').hidden = hasTasks;
  $('tiles').hidden = !hasTasks;
}

function renderTaskList() {
  const list = $('taskList');
  list.innerHTML = '';

  if (!state.tasks.length) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = 'No tasks yet.';
    list.appendChild(empty);
    return;
  }

  for (const task of state.tasks) {
    const item = document.createElement('li');
    item.className = `task-item${task.id === state.activeTaskId ? ' is-active' : ''}`;
    const last = [...task.messages].reverse().find((m) => m.role === 'assistant' && m.content);
    item.innerHTML = `
      <span class="dot ${task.status}"></span>
      <span class="grow">
        <span class="t">${escapeHtml(task.title)}</span>
        <span class="s">${escapeHtml(task.status === 'running' ? 'streaming…' : truncate((last?.content || 'empty').replace(/\s+/g, ' '), 52))}</span>
      </span>`;

    item.addEventListener('click', () => {
      state.activeTaskId = task.id;
      renderAll();
    });
    list.appendChild(item);
  }
}

function renderTiles() {
  const container = $('tiles');
  container.innerHTML = '';
  const open = state.tasks.slice(0, 4);
  container.dataset.count = String(Math.max(1, Math.min(open.length, 4)));

  for (const task of open) {
    container.appendChild(buildTile(task));
  }
}

function buildTile(task) {
  const tile = document.createElement('section');
  tile.className = [
    'tile',
    task.id === state.activeTaskId ? 'is-focused' : '',
    task.id === state.maximizedTaskId ? 'is-maximized' : '',
  ]
    .filter(Boolean)
    .join(' ');
  tile.dataset.task = task.id;
  tile.addEventListener('mousedown', () => {
    if (state.activeTaskId !== task.id) {
      state.activeTaskId = task.id;
      renderAll();
    }
  });

  const statusClass =
    task.status === 'running' ? 'badge-running' : task.status === 'error' ? 'badge-error' : task.status === 'done' ? 'badge-success' : 'badge-muted';

  const head = document.createElement('header');
  head.className = 'tile-head';
  head.innerHTML = `
    <input class="tile-title" value="${escapeHtml(task.title)}" aria-label="Task title" />
    <span class="badge ${statusClass}">${task.status === 'running' ? 'running' : task.status}</span>
    <div class="tile-actions">
      <button class="icon-btn" data-act="maximize" title="${task.id === state.maximizedTaskId ? 'Restore' : 'Maximize'}">
        <span class="glyph">${task.id === state.maximizedTaskId ? '⤡' : '⤢'}</span>
      </button>
      <button class="icon-btn" data-act="close" title="Close task"><span class="glyph">✕</span></button>
    </div>`;

  const titleInput = head.querySelector('.tile-title');
  titleInput.addEventListener('change', () => {
    task.title = titleInput.value.trim() || 'Untitled task';
    saveTasks();
    renderTaskList();
  });
  head.querySelector('[data-act="maximize"]').addEventListener('click', () => {
    state.maximizedTaskId = state.maximizedTaskId === task.id ? null : task.id;
    renderAll();
  });
  head.querySelector('[data-act="close"]').addEventListener('click', () => removeTask(task.id));

  const body = document.createElement('div');
  body.className = 'tile-body';
  if (!task.messages.length) {
    const blank = document.createElement('p');
    blank.className = 'hint';
    blank.textContent = 'Ask a question, paste an error, or describe the change you want.';
    body.appendChild(blank);
  }
  task.messages.forEach((message, index) => body.appendChild(buildMessage(task, message, index)));

  const composer = document.createElement('form');
  composer.className = 'composer';
  const attached = task.id === state.activeTaskId ? state.attachments.size : 0;
  composer.innerHTML = `
    <textarea id="prompt-${task.id}" placeholder="Ask anything. Enter sends, Shift+Enter adds a line." rows="2">${escapeHtml(state.drafts[task.id] || '')}</textarea>
    <div class="composer-bar">
      <span class="grow">${attached ? `${attached} file(s) attached` : 'no files attached'}</span>
      <button class="btn btn-danger" type="button" data-act="stop" ${state.stream && state.stream.taskId === task.id ? '' : 'hidden'}>Stop</button>
      <button class="btn btn-primary" type="submit" ${state.stream ? 'disabled' : ''}>Send</button>
    </div>`;

  const input = composer.querySelector('textarea');
  input.addEventListener('input', () => {
    state.drafts[task.id] = input.value;
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    delete state.drafts[task.id];
    sendPrompt(task.id, value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.querySelector('[data-act="stop"]').addEventListener('click', async () => {
    await api.chat.abort();
    setStatus('Stopping…');
  });

  tile.append(head, body, composer);
  if (task.id === state.activeTaskId) {
    requestAnimationFrame(() => body.scrollTo({ top: body.scrollHeight }));
  }
  return tile;
}

function buildMessage(task, message, index) {
  const node = document.createElement('div');
  node.className = `msg msg-${message.role}${message.error ? ' msg-error' : ''}`;

  const isStreaming = Boolean(message.streaming) && state.stream;
  const head = `<div class="msg-head"><span>${message.role === 'user' ? 'You' : 'Lantern'}</span>
    <button class="link-btn" data-act="copy">copy</button></div>`;

  node.innerHTML = `${head}<div class="body"${isStreaming ? ` data-stream="${task.id}"` : ''}></div>
    ${message.meta ? `<div class="msg-meta">${escapeHtml(message.meta)}</div>` : ''}
    ${
      message.attached && message.attached.length
        ? `<div class="chips">${message.attached.map((file) => `<span class="chip">${escapeHtml(file)}</span>`).join('')}</div>`
        : ''
    }`;

  const bodyNode = node.querySelector('.body');
  if (isStreaming) bodyNode.innerHTML = `${renderMarkdown(state.stream.text)}<span class="cursor"></span>`;
  else bodyNode.innerHTML = renderMarkdown(message.content);

  node.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    const text = isStreaming ? state.stream.text : task.messages[index].content;
    await navigator.clipboard.writeText(text);
    setStatus('Copied to clipboard.');
  });

  return node;
}

function renderProviderSelect() {
  const select = $('providerSelect');
  select.innerHTML = '';
  if (!state.settings.providers.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'no provider';
    select.appendChild(option);
    return;
  }
  for (const provider of state.settings.providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.model ? `${provider.name} · ${provider.model}` : provider.name;
    option.selected = provider.active;
    select.appendChild(option);
  }
}

function renderAttachSummary() {
  const count = state.attachments.size;
  $('attachCount').textContent = `${count} file${count === 1 ? '' : 's'} attached`;
}

/* ───────────────────────────────────────────────────────────── workspace ── */

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
    row.style.paddingLeft = `${4 + depth * 11}px`;

    if (entry.type === 'dir') {
      row.innerHTML = `<span class="dir">${escapeHtml(entry.path.split('/').pop())}/</span>`;
    } else {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.attachments.has(entry.path);
      box.addEventListener('change', () => {
        if (box.checked) state.attachments.add(entry.path);
        else state.attachments.delete(entry.path);
        renderAttachSummary();
        renderTiles();
      });
      row.append(box, document.createTextNode(entry.path.split('/').pop()));
    }
    fragment.appendChild(row);
  }
  tree.appendChild(fragment);
}

async function loadWorkspace() {
  const path = state.settings.workspace;
  $('workspacePath').textContent = path || 'No folder selected.';
  $('workspaceName').textContent = path ? path.split(/[\\/]/).filter(Boolean).pop() : 'No workspace';

  if (!path) {
    state.tree = null;
    renderTree();
    return;
  }
  const result = await api.workspace.list();
  state.tree = result.ok ? result.tree : null;
  if (!result.ok) setStatus(result.error, 'error');
  renderTree();
}

/* ──────────────────────────────────────────────────────────── providers ── */

function renderProviderList() {
  const list = $('providerList');
  list.innerHTML = '';
  if (!state.settings.providers.length) {
    list.innerHTML = '<li class="hint">Nothing configured yet.</li>';
    return;
  }
  for (const provider of state.settings.providers) {
    const item = document.createElement('li');
    item.className = `provider-item${provider.active ? ' active' : ''}${provider.id === state.editingProviderId ? ' editing' : ''}`;
    item.innerHTML = `
      <div class="grow">
        <div class="name">${escapeHtml(provider.name)}${provider.active ? ' ★' : ''}</div>
        <div class="sub">${escapeHtml(provider.kindLabel)} · ${escapeHtml(provider.model)}${provider.hasKey ? '' : ' · no key'}</div>
      </div>
      <button class="mini-btn" data-act="use" type="button">${provider.active ? 'active' : 'use'}</button>`;

    item.addEventListener('click', () => loadProviderForm(provider.id));
    item.querySelector('[data-act="use"]').addEventListener('click', async (event) => {
      event.stopPropagation();
      await api.providers.activate(provider.id);
      await refreshSettings();
      setStatus(`${provider.name} is now the active provider.`, 'ok');
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
  $('fHeaders').value =
    values.extraHeaders && Object.keys(values.extraHeaders).length ? JSON.stringify(values.extraHeaders, null, 2) : '';
  if (!keepKey) $('fApiKey').value = values.apiKey || '';
}

function newProviderForm() {
  state.editingProviderId = null;
  $('formTitle').textContent = 'New provider';
  $('deleteProvider').hidden = true;
  fillForm({ kind: 'openai-compatible', maxTokens: 4096, stream: true });
  $('fApiPath').placeholder = '/chat/completions';
  setProviderStatus('');
  renderProviderList();
}

function loadProviderForm(id) {
  const provider = state.settings.providers.find((row) => row.id === id);
  if (!provider) return newProviderForm();
  state.editingProviderId = id;
  $('formTitle').textContent = `Editing ${provider.name}`;
  $('deleteProvider').hidden = false;
  fillForm(provider);
  $('fApiKey').placeholder = provider.hasKey ? 'leave empty to keep the saved key' : 'no key saved';
  setProviderStatus('');
  renderProviderList();
}

function setProviderStatus(message, kind = '') {
  const node = $('providerStatus');
  node.textContent = message;
  node.className = `status ${kind}`.trim();
}

async function saveProviderForm() {
  let values;
  try {
    values = currentFormValues();
  } catch (error) {
    setProviderStatus(`Extra headers must be valid JSON (${error.message}).`, 'error');
    return;
  }

  const result = state.editingProviderId
    ? await api.providers.update(state.editingProviderId, { ...values, apiKey: values.apiKey || undefined })
    : await api.providers.add(values);

  if (!result.ok) {
    setProviderStatus(result.errors.join(' '), 'error');
    return;
  }

  setProviderStatus(`Saved "${result.provider.name}".`, 'ok');
  state.editingProviderId = result.provider.id;
  await refreshSettings();
  loadProviderForm(result.provider.id);
  $('fApiKey').value = '';
}

async function testProviderForm() {
  setProviderStatus('Testing…');
  let payload;
  if (state.editingProviderId && !$('fApiKey').value) {
    payload = { id: state.editingProviderId };
  } else {
    try {
      payload = { draft: currentFormValues() };
    } catch (error) {
      setProviderStatus(`Fix the JSON headers first (${error.message}).`, 'error');
      return;
    }
  }

  const result = await api.providers.test(payload);
  if (result.ok) {
    setProviderStatus(`OK in ${result.latencyMs} ms — reply: "${result.reply.trim() || '(empty)'}"`, 'ok');
  } else {
    setProviderStatus(
      `Failed${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error}${result.detail ? ` — ${result.detail}` : ''}`,
      'error',
    );
  }
}

async function fetchModels() {
  if (!state.editingProviderId) {
    setProviderStatus('Save the provider first, then list its models.', 'error');
    return;
  }
  setProviderStatus('Asking the endpoint for its models…');
  const result = await api.providers.models(state.editingProviderId);
  if (!result.ok) {
    setProviderStatus(`Could not list models: ${result.error}`, 'error');
    return;
  }
  const list = $('modelList');
  list.innerHTML = '';
  for (const model of result.models) {
    const option = document.createElement('option');
    option.value = model;
    list.appendChild(option);
  }
  setProviderStatus(`${result.models.length} model(s) available — start typing in the model field.`, 'ok');
}

async function deleteProviderForm() {
  if (!state.editingProviderId) return;
  await api.providers.remove(state.editingProviderId);
  state.editingProviderId = null;
  await refreshSettings();
  newProviderForm();
  setProviderStatus('Provider removed.', 'ok');
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
      setProviderStatus(`${preset.label} endpoint filled in — set the model, and the key if it needs one.`);
    });
    box.appendChild(chip);
  }
}

/* ────────────────────────────────────────────────────────── palette ── */

function buildPaletteItems(query) {
  const term = query.trim().toLowerCase();
  const items = [];

  const commands = [
    { label: 'New task', hint: 'Ctrl N', run: () => createTask() },
    { label: 'Choose workspace folder', hint: '', run: () => chooseWorkspace() },
    { label: 'Open provider settings', hint: '', run: () => $('settingsDialog').showModal() },
    { label: 'Toggle theme', hint: '', run: () => toggleTheme() },
    {
      label: 'Toggle sidebar',
      hint: '',
      run: () => $('sidebar').parentElement.classList.toggle('sidebar-hidden'),
    },
    { label: 'Close all tasks', hint: '', run: () => { state.tasks = []; state.activeTaskId = null; saveTasks(); renderAll(); } },
    { label: 'Clear attached files', hint: '', run: () => { state.attachments.clear(); renderTree(); renderAll(); } },
  ];

  for (const provider of state.settings.providers) {
    commands.push({
      label: `Use provider: ${provider.name}`,
      hint: provider.model,
      run: async () => {
        await api.providers.activate(provider.id);
        await refreshSettings();
      },
    });
  }

  for (const item of commands) {
    if (!term || item.label.toLowerCase().includes(term)) {
      items.push({ kind: 'command', label: item.label, sub: item.hint, run: item.run });
    }
  }

  for (const task of state.tasks) {
    if (!term || task.title.toLowerCase().includes(term)) {
      items.push({
        kind: 'task',
        label: task.title,
        sub: `${task.messages.length} message(s)`,
        run: () => {
          state.activeTaskId = task.id;
          renderAll();
        },
      });
    }
  }

  return items.slice(0, 24);
}

function openPalette() {
  state.palette.open = true;
  $('palette').hidden = false;
  $('paletteScrim').hidden = false;
  $('paletteInput').value = '';
  state.palette.index = 0;
  renderPalette();
  $('paletteInput').focus();
}

function closePalette() {
  state.palette.open = false;
  $('palette').hidden = true;
  $('paletteScrim').hidden = true;
}

function renderPalette() {
  const items = buildPaletteItems($('paletteInput').value);
  state.palette.items = items;
  if (state.palette.index >= items.length) state.palette.index = Math.max(0, items.length - 1);

  const list = $('paletteList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="palette-empty">Nothing matches.</li>';
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = `palette-item${index === state.palette.index ? ' is-selected' : ''}`;
    row.innerHTML = `<span class="glyph dim">${item.kind === 'task' ? '◈' : '⌘'}</span>
      <span class="grow">${escapeHtml(item.label)}</span>
      <span class="sub">${escapeHtml(item.sub || '')}</span>`;
    row.addEventListener('click', () => runPaletteItem(index));
    row.addEventListener('mousemove', () => {
      state.palette.index = index;
      list.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('is-selected', i === index));
    });
    list.appendChild(row);
  });
}

function runPaletteItem(index) {
  const item = state.palette.items[index];
  closePalette();
  if (item) Promise.resolve(item.run()).catch((error) => setStatus(error.message, 'error'));
}

/* ───────────────────────────────────────────────────────────── settings ── */

async function refreshSettings() {
  state.settings = await api.settings.get();
  renderProviderSelect();
  renderProviderList();
  $('keyStorageInfo').textContent = state.settings.keyStorageSecure
    ? `keys sealed with the OS keychain (${state.settings.keyStorage})`
    : 'keys stored in plain text in the app settings file';
  $('keyHint').textContent = state.settings.keyStorageSecure
    ? 'stored locally, encrypted with your OS keychain'
    : 'stored locally in plain text (OS keychain unavailable)';
  $('workspaceName').textContent = state.settings.workspace
    ? state.settings.workspace.split(/[\\/]/).filter(Boolean).pop()
    : 'No workspace';
}

function applyTheme(theme) {
  const resolved =
    theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  document.documentElement.classList.toggle('light', resolved === 'light');
  document.documentElement.classList.toggle('dark', resolved !== 'light');
  $('themeToggle').textContent = resolved === 'light' ? '☾' : '☀';
  return resolved;
}

async function toggleTheme() {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  applyTheme(next);
  await api.settings.setUi({ theme: next });
}

async function chooseWorkspace() {
  const result = await api.workspace.choose();
  if (!result.ok) return;
  state.attachments.clear();
  await refreshSettings();
  await loadWorkspace();
  renderAll();
}

/* ───────────────────────────────────────────────────────────────── boot ── */

async function boot() {
  state.info = await api.info();
  $('versionInfo').textContent = `Lantern ${state.info.version}`;

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
  applyTheme(state.settings.ui?.theme || 'system');
  renderPresets();
  newProviderForm();

  state.tasks = loadTasks();
  state.activeTaskId = state.tasks[0] ? state.tasks[0].id : null;
  renderAll();

  await loadWorkspace();

  if (!state.settings.providers.length) $('settingsDialog').showModal();

  window.__lanternReady = true;
}

/* ───────────────────────────────────────────────────────────── events ── */

$('newTask').addEventListener('click', () => createTask());
$('railAdd').addEventListener('click', () => createTask());
$('startTask').addEventListener('click', () => createTask());
$('emptySettings').addEventListener('click', () => $('settingsDialog').showModal());
$('openSettings').addEventListener('click', () => $('settingsDialog').showModal());
$('themeToggle').addEventListener('click', () => toggleTheme());
$('workspaceButton').addEventListener('click', () => chooseWorkspace());
$('chooseWorkspace').addEventListener('click', () => chooseWorkspace());
$('toggleSidebar').addEventListener('click', () => {
  $('sidebar').parentElement.classList.toggle('sidebar-hidden');
});

$('railTasks').addEventListener('click', () => {
  $('railTasks').classList.add('is-active');
  $('railFiles').classList.remove('is-active');
  $('tasksPanel').hidden = false;
  $('filesPanel').hidden = true;
});

$('railFiles').addEventListener('click', () => {
  $('railFiles').classList.add('is-active');
  $('railTasks').classList.remove('is-active');
  $('filesPanel').hidden = false;
  $('tasksPanel').hidden = true;
});

$('clearAttachments').addEventListener('click', () => {
  state.attachments.clear();
  renderTree();
  renderAll();
});

$('providerSelect').addEventListener('change', async (event) => {
  if (!event.target.value) return;
  await api.providers.activate(event.target.value);
  await refreshSettings();
});

$('paletteButton').addEventListener('click', () => openPalette());
$('paletteScrim').addEventListener('click', () => closePalette());
$('paletteInput').addEventListener('input', () => {
  state.palette.index = 0;
  renderPalette();
});
$('paletteInput').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.palette.index = Math.min(state.palette.index + 1, state.palette.items.length - 1);
    renderPalette();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.palette.index = Math.max(state.palette.index - 1, 0);
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPaletteItem(state.palette.index);
  } else if (event.key === 'Escape') {
    closePalette();
  }
});

$('newProvider').addEventListener('click', () => newProviderForm());
$('saveProvider').addEventListener('click', () => saveProviderForm());
$('testProvider').addEventListener('click', () => testProviderForm());
$('deleteProvider').addEventListener('click', () => deleteProviderForm());
$('fetchModels').addEventListener('click', () => fetchModels());

$('fKind').addEventListener('change', (event) => {
  const kind = state.kinds.find((row) => row.id === event.target.value);
  if (!kind) return;
  $('fApiPath').placeholder = kind.defaultPath;
  if (!$('fBaseUrl').value) $('fBaseUrl').value = kind.defaultBaseUrl;
});

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.palette.open) closePalette();
    else openPalette();
  } else if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    createTask();
  } else if (event.key === 'Escape') {
    if (state.palette.open) closePalette();
    else if ($('settingsDialog').open) $('settingsDialog').close();
    else if (state.maximizedTaskId) {
      state.maximizedTaskId = null;
      renderAll();
    }
  }
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((state.settings?.ui?.theme || 'system') === 'system') applyTheme('system');
});

window.addEventListener('unhandledrejection', (event) => {
  setStatus(`Unexpected error: ${event.reason?.message || event.reason}`, 'error');
});

boot().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#ff9c9c">Lantern failed to start:\n${escapeHtml(
    error.stack || error.message,
  )}</pre>`;
});

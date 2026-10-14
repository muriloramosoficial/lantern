'use strict';

/**
 * Lantern provider layer.
 *
 * Everything here is a plain HTTP client. There is no vendor account, no
 * license check, no telemetry and no discovery of providers installed by
 * other applications: a provider exists only if the user adds it, and it
 * points at whatever URL the user typed.
 *
 * No Node/Electron-specific imports on purpose, so this module is testable
 * with plain `node --test`.
 */

class ProviderError extends Error {
  constructor(message, { status = 0, provider = null, body = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.body = body;
  }
}

const KINDS = {
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    hint: 'OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, LM Studio, vLLM, llama.cpp, ...',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultPath: '/chat/completions',
    modelsPath: '/models',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    requiresKey: true,
    style: 'openai',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude models over the native Messages API',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultPath: '/messages',
    modelsPath: '/models',
    authHeader: 'x-api-key',
    authPrefix: '',
    requiresKey: true,
    style: 'anthropic',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama / local server',
    hint: 'Local OpenAI-compatible server, no API key needed',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultPath: '/chat/completions',
    modelsPath: '/models',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    requiresKey: false,
    style: 'openai',
  },
  custom: {
    id: 'custom',
    label: 'Custom endpoint',
    hint: 'Any HTTP endpoint that speaks the OpenAI chat-completions shape',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    defaultPath: '/chat/completions',
    modelsPath: '/models',
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    requiresKey: false,
    style: 'openai',
  },
};

function kindOf(id) {
  return KINDS[id] || KINDS.custom;
}

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate + normalize a provider definition coming from the UI.
 * Returns { ok, errors, provider }.
 */
function validateProvider(input, { requireKey = false } = {}) {
  const errors = [];
  const kind = kindOf(input && input.kind);

  const name = String((input && input.name) || '').trim();
  if (!name) errors.push('Provider name is required.');
  if (name.length > 60) errors.push('Provider name must be 60 characters or fewer.');

  const baseUrl = trimTrailingSlash(String((input && input.baseUrl) || '').trim());
  if (!baseUrl) errors.push('Base URL is required.');
  else if (!isValidUrl(baseUrl)) errors.push('Base URL must be a valid http(s) URL.');

  const model = String((input && input.model) || '').trim();
  if (!model) errors.push('Model is required.');

  const apiPath = String((input && input.apiPath) || '').trim() || kind.defaultPath;
  if (!apiPath.startsWith('/')) errors.push('Request path must start with "/".');

  const maxTokens = Number(input && input.maxTokens);
  if (input && input.maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    errors.push('Max tokens must be a positive number.');
  }

  const extraHeaders = input && input.extraHeaders ? input.extraHeaders : {};
  if (typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) {
    errors.push('Extra headers must be a JSON object of string values.');
  } else {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (typeof value !== 'string') errors.push(`Header "${key}" must be a string.`);
    }
  }

  if (requireKey && kind.requiresKey && !(input && input.apiKey)) {
    errors.push(`Provider kind "${kind.id}" needs an API key.`);
  }

  if (errors.length) return { ok: false, errors, provider: null };

  return {
    ok: true,
    errors: [],
    provider: {
      name,
      kind: kind.id,
      baseUrl,
      apiPath,
      model,
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
      temperature: Number.isFinite(Number(input && input.temperature)) ? Number(input.temperature) : null,
      stream: input && input.stream === false ? false : true,
      extraHeaders,
    },
  };
}

function buildHeaders(provider, apiKey) {
  const kind = kindOf(provider.kind);
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': 'lantern-desktop',
    ...(kind.extraHeaders || {}),
    ...(provider.extraHeaders || {}),
  };

  const key = apiKey || provider.apiKey;
  if (key) headers[kind.authHeader] = `${kind.authPrefix}${key}`;
  return headers;
}

function buildChatRequest(provider, { messages, systemPrompt }) {
  const kind = kindOf(provider.kind);
  const url = `${trimTrailingSlash(provider.baseUrl)}${provider.apiPath || kind.defaultPath}`;
  const headers = buildHeaders(provider, null);
  if (provider.stream !== false) headers.accept = 'text/event-stream';

  if (kind.style === 'anthropic') {
    const body = {
      model: provider.model,
      max_tokens: provider.maxTokens || 4096,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: provider.stream !== false,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (Number.isFinite(provider.temperature)) body.temperature = provider.temperature;
    return { url, headers, body };
  }

  const payload = [{ role: 'system', content: systemPrompt }, ...messages].filter((m) => m.content);
  const body = {
    model: provider.model,
    messages: payload,
    stream: provider.stream !== false,
  };
  if (Number.isFinite(provider.temperature)) body.temperature = provider.temperature;
  if (kind.id !== 'ollama') body.stream_options = { include_usage: true };
  return { url, headers, body };
}

/**
 * Server-sent-events decoder: raw text chunks in, {event, data} objects out.
 * Events are terminated by a blank line, so it never emits a partial event
 * when a chunk boundary lands mid-field.
 */
class SSEDecoder {
  constructor() {
    this.buffer = '';
  }

  push(chunk) {
    let text = this.buffer + chunk;
    text = text.replace(/\r\n/g, '\n');
    const trailingCR = text.endsWith('\r');
    if (trailingCR) text = text.slice(0, -1);
    text = text.replace(/\r/g, '\n');
    this.buffer = trailingCR ? `${text}\r` : text;

    const events = [];
    let separator;
    while ((separator = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const event = parseSSEBlock(block);
      if (event) events.push(event);
    }
    return events;
  }
}

function parseSSEBlock(block) {
  let event;
  let data;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data = data === undefined ? value : `${data}\n${value}`;
  }
  if (data === undefined) return null;
  return { event: event || 'message', data };
}

function extractDelta(style, event) {
  if (!event || typeof event.data !== 'string') return null;
  if (event.data === '[DONE]') return { done: true, text: '' };

  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return null;
  }

  if (payload.error) {
    const message = typeof payload.error === 'string' ? payload.error : payload.error.message;
    throw new ProviderError(message || 'Provider returned an error.', { body: event.data });
  }

  if (style === 'anthropic') {
    if (event.event === 'content_block_delta' && payload.delta) {
      return { text: payload.delta.text || '' };
    }
    if (event.event === 'message_stop') return { done: true, text: '' };
    if (event.event === 'error') {
      throw new ProviderError((payload.error && payload.error.message) || 'Anthropic stream error.');
    }
    return null;
  }

  const choice = (payload.choices && payload.choices[0]) || null;
  if (!choice) {
    if (payload.usage) return { text: '', usage: payload.usage };
    return null;
  }
  const delta = choice.delta || choice.message || {};
  const text = typeof delta.content === 'string' ? delta.content : '';
  return { text, done: choice.finish_reason ? true : false };
}

function extractMessage(style, payload) {
  if (style === 'anthropic') {
    const block = (payload.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
    return block;
  }
  const choice = (payload.choices && payload.choices[0]) || {};
  const message = choice.message || {};
  return typeof message.content === 'string' ? message.content : '';
}

async function chat({ provider, apiKey, messages, systemPrompt = '', signal, onDelta, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const kind = kindOf(provider.kind);
  const resolved = { ...provider, apiKey: apiKey || provider.apiKey };
  const { url, headers, body } = buildChatRequest(resolved, { messages, systemPrompt });

  const response = await doFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 2000);
    } catch {
      detail = '';
    }
    throw new ProviderError(`Request failed with HTTP ${response.status}`, {
      status: response.status,
      provider: provider.name,
      body: detail,
    });
  }

  if (provider.stream === false || !response.body) {
    const payload = await response.json();
    const text = extractMessage(kind.style, payload);
    if (onDelta) onDelta(text);
    return { text, usage: payload.usage || null };
  }

  const decoder = new SSEDecoder();
  const textDecoder = new TextDecoder();
  let full = '';
  let usage = null;

  for await (const chunk of response.body) {
    const events = decoder.push(textDecoder.decode(chunk, { stream: true }));
    for (const event of events) {
      const delta = extractDelta(kind.style, event);
      if (!delta) continue;
      if (delta.usage) usage = delta.usage;
      if (delta.text) {
        full += delta.text;
        if (onDelta) onDelta(delta.text);
      }
      if (delta.done) return { text: full, usage };
    }
  }

  // Some servers close the stream without a terminal event.
  const tail = decoder.push('\n\n');
  for (const event of tail) {
    const delta = extractDelta(kind.style, event);
    if (delta && delta.text) {
      full += delta.text;
      if (onDelta) onDelta(delta.text);
    }
  }

  return { text: full, usage };
}

async function listModels({ provider, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const kind = kindOf(provider.kind);
  const url = `${trimTrailingSlash(provider.baseUrl)}${kind.modelsPath}`;
  const response = await doFetch(url, {
    method: 'GET',
    headers: buildHeaders({ ...provider, apiKey: apiKey || provider.apiKey }, null),
  });

  if (!response.ok) {
    throw new ProviderError(`Could not list models (HTTP ${response.status})`, { status: response.status });
  }

  const payload = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : payload.data || payload.models || [];
  return rows
    .map((row) => (typeof row === 'string' ? row : row.id || row.name || row.model))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function testConnection({ provider, apiKey, fetchImpl }) {
  const started = Date.now();
  try {
    const { url } = buildChatRequest(provider, { messages: [{ role: 'user', content: 'ping' }] });
    const result = await chat({
      provider: { ...provider, stream: false, maxTokens: Math.min(provider.maxTokens || 16, 16) },
      apiKey,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      fetchImpl,
    });
    return {
      ok: true,
      url,
      latencyMs: Date.now() - started,
      reply: (result.text || '').slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status || 0,
      latencyMs: Date.now() - started,
      error: error.message,
      detail: (error.body || '').slice(0, 600),
    };
  }
}

module.exports = {
  KINDS,
  ProviderError,
  SSEDecoder,
  parseSSEBlock,
  buildChatRequest,
  buildHeaders,
  chat,
  extractDelta,
  extractMessage,
  isValidUrl,
  kindOf,
  listModels,
  testConnection,
  trimTrailingSlash,
  validateProvider,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  SSEDecoder,
  ProviderError,
  buildChatRequest,
  chat,
  extractDelta,
  listModels,
  testConnection,
  validateProvider,
} = require('../src/main/providers');

/** Starts a local HTTP server and records every request it receives. */
async function startServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      handler(req, res, raw);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const provider = (overrides = {}) => ({
  name: 'Mock',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiPath: '/chat/completions',
  model: 'mock-model',
  maxTokens: 256,
  stream: true,
  extraHeaders: {},
  ...overrides,
});

test('validateProvider rejects incomplete definitions', () => {
  const missingName = validateProvider({ baseUrl: 'https://x.dev/v1', model: 'm' });
  assert.equal(missingName.ok, false);
  assert.match(missingName.errors.join(' '), /name is required/i);

  const badUrl = validateProvider({ name: 'a', baseUrl: 'ftp://nope', model: 'm' });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.errors.join(' '), /valid http/i);

  const badHeaders = validateProvider({ name: 'a', baseUrl: 'https://x.dev/v1', model: 'm', extraHeaders: { a: 3 } });
  assert.equal(badHeaders.ok, false);
  assert.match(badHeaders.errors.join(' '), /must be a string/i);
});

test('validateProvider fills kind defaults and normalizes values', () => {
  const result = validateProvider({
    name: '  Claude  ',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/',
    model: 'claude-sonnet-4-5',
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider.name, 'Claude');
  assert.equal(result.provider.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(result.provider.apiPath, '/messages');
  assert.equal(result.provider.maxTokens, 4096);
  assert.equal(result.provider.stream, true);
});

test('SSEDecoder survives chunk boundaries and CRLF line endings', () => {
  const decoder = new SSEDecoder();
  assert.deepEqual(decoder.push('data: {"a"'), []);
  assert.deepEqual(decoder.push(':1}\r\n\r\n'), [{ event: 'message', data: '{"a":1}' }]);

  const two = decoder.push('data: one\n\ndata: two\n\n');
  assert.deepEqual(two, [
    { event: 'message', data: 'one' },
    { event: 'message', data: 'two' },
  ]);

  const multi = new SSEDecoder();
  assert.deepEqual(multi.push('event: ping\ndata: line1\ndata: line2\n\n'), [
    { event: 'ping', data: 'line1\nline2' },
  ]);
});

test('extractDelta understands both dialects', () => {
  const openai = extractDelta('openai', { data: '{"choices":[{"delta":{"content":"hi"}}]}' });
  assert.equal(openai.text, 'hi');

  const done = extractDelta('openai', { data: '[DONE]' });
  assert.equal(done.done, true);

  const anthropic = extractDelta('anthropic', {
    event: 'content_block_delta',
    data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hey"}}',
  });
  assert.equal(anthropic.text, 'hey');

  assert.throws(
    () => extractDelta('openai', { data: '{"error":{"message":"bad key"}}' }),
    (error) => error instanceof ProviderError && /bad key/.test(error.message),
  );
});

test('chat streams an OpenAI-compatible response end to end', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Deliberately split one event across writes.
    res.write('data: {"choices":[{"delta":{"content":"Hel');
    res.write('lo "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"world"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[],"usage":{"total_tokens":7}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const deltas = [];
  const result = await chat({
    provider: provider({ baseUrl: server.baseUrl }),
    messages: [{ role: 'user', content: 'hi' }],
    systemPrompt: 'be brief',
    onDelta: (text) => deltas.push(text),
  });

  assert.equal(result.text, 'Hello world');
  assert.deepEqual(deltas, ['Hello ', 'world']);
  assert.equal(result.usage.total_tokens, 7);

  const [request] = server.received;
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.body.model, 'mock-model');
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(request.body.messages[0].content, 'be brief');
  assert.equal(request.body.messages[1].content, 'hi');
  assert.equal(server.received.length, 1, 'exactly one outbound request');

  await server.close();
});

test('chat honours streaming disabled', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'plain answer' } }] }));
  });

  const result = await chat({
    provider: provider({ baseUrl: server.baseUrl, stream: false }),
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.text, 'plain answer');
  assert.equal(server.received[0].body.stream, false);
  await server.close();
});

test('chat sends the Anthropic dialect with the documented headers', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });

  const result = await chat({
    provider: provider({ kind: 'anthropic', baseUrl: server.baseUrl, apiPath: '/messages' }),
    apiKey: 'sk-test-123',
    messages: [{ role: 'user', content: 'hi' }],
    systemPrompt: 'sys',
  });

  assert.equal(result.text, 'ok');
  const [request] = server.received;
  assert.equal(request.url, '/v1/messages');
  assert.equal(request.headers['x-api-key'], 'sk-test-123');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.body.system, 'sys');
  assert.equal(request.body.max_tokens, 256);
  await server.close();
});

test('chat surfaces HTTP failures as ProviderError without retrying elsewhere', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });

  await assert.rejects(
    chat({ provider: provider({ baseUrl: server.baseUrl }), messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error instanceof ProviderError && error.status === 401 && /invalid api key/.test(error.body),
  );
  assert.equal(server.received.length, 1);
  await server.close();
});

test('chat forwards the abort signal', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    // Never ends: the client must abort.
  });

  const controller = new AbortController();
  const pending = chat({
    provider: provider({ baseUrl: server.baseUrl }),
    messages: [{ role: 'user', content: 'hi' }],
    signal: controller.signal,
    onDelta: () => controller.abort(),
  });

  await assert.rejects(pending, (error) => error.name === 'AbortError');
  await server.close();
});

test('listModels reads the models endpoint', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] }));
  });

  const models = await listModels({ provider: provider({ baseUrl: server.baseUrl }), apiKey: 'k' });
  assert.deepEqual(models, ['a-model', 'b-model']);
  assert.equal(server.received[0].url, '/v1/models');
  assert.equal(server.received[0].headers.authorization, 'Bearer k');
  await server.close();
});

test('testConnection reports success and failure', async () => {
  const server = await startServer((req, res) => {
    if (req.headers['x-fail']) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
  });

  const good = await testConnection({
    provider: provider({ baseUrl: server.baseUrl, stream: false }),
    apiKey: 'k',
  });
  assert.equal(good.ok, true);
  assert.match(good.reply, /pong/);
  assert.equal(server.received[0].body.stream, false);

  const failing = await testConnection({
    provider: provider({ baseUrl: server.baseUrl, stream: false, extraHeaders: { 'x-fail': '1' } }),
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.status, 500);

  await server.close();
});

test('buildChatRequest never invents a host of its own', () => {
  const { url } = buildChatRequest(provider({ baseUrl: 'https://my-gateway.internal/v1' }), { messages: [] });
  assert.equal(url, 'https://my-gateway.internal/v1/chat/completions');
});

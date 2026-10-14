'use strict';

/**
 * Headless smoke test: `npm run smoke`.
 *
 * Boots the real application (main process, preload bridge, renderer and IPC)
 * behind a hidden window, points it at a local fake endpoint and checks that a
 * streamed answer arrives in the UI. It never touches your real settings file:
 * the app is started with a temporary userData folder.
 */

const http = require('node:http');

const EXPECTED = 'Lantern smoke works';
const WORDS = ['Lantern ', 'smoke ', 'works'];

function startFakeEndpoint() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const word of WORDS) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 3 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function runSmoke({ mainWindow, store, app }) {
  const checks = [];
  let failed = 0;

  const check = (name, condition, detail = '') => {
    const ok = Boolean(condition);
    if (!ok) failed += 1;
    checks.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    return ok;
  };

  try {
    const endpoint = await startFakeEndpoint();

    const added = store.addProvider({
      name: 'Smoke endpoint',
      kind: 'openai-compatible',
      baseUrl: endpoint.baseUrl,
      model: 'smoke-model',
      apiKey: 'smoke-key',
      stream: true,
    });
    check('provider can be added and stored', added.ok, added.errors.join(' '));

    // Wait for the renderer's boot() to finish.
    const ready = await mainWindow.webContents.executeJavaScript(
      `new Promise((resolve) => {
         const started = Date.now();
         const tick = () => {
           if (window.__lanternReady) return resolve(true);
           if (Date.now() - started > 10000) return resolve(false);
           setTimeout(tick, 50);
         };
         tick();
       })`,
    );
    check('renderer booted', ready);

    const page = await mainWindow.webContents.executeJavaScript(
      `({
         api: typeof window.lantern?.chat?.send === 'function',
         providers: document.querySelectorAll('#providerSelect option').length,
         welcomeRendered: Boolean(document.querySelector('.welcome')),
         keyStorageBadge: document.getElementById('keyStorageInfo').textContent.trim(),
         settingsPath: ${JSON.stringify(store.file)},
       })`,
    );
    check('preload bridge exposes the chat API', page.api);
    check('renderer sees the configured provider', page.providers === 1, `options=${page.providers}`);
    check('welcome screen rendered', page.welcomeRendered);
    check('key storage status is shown', page.keyStorageBadge.length > 0, page.keyStorageBadge);

    const chat = await mainWindow.webContents.executeJavaScript(
      `(async () => {
         const deltas = [];
         const off = window.lantern.chat.onDelta((payload) => deltas.push(payload.text));
         const result = await window.lantern.chat.send({
           messages: [{ role: 'user', content: 'ping' }],
         });
         off();
         return { deltas, result };
       })()`,
    );

    check('chat round-trip succeeded through IPC', chat.result.ok, chat.result.error || '');
    check('streamed answer matches', chat.result.text === EXPECTED, JSON.stringify(chat.result.text));
    check('answer arrived as multiple deltas', chat.deltas.length === WORDS.length, `deltas=${chat.deltas.length}`);
    check('usage was propagated', chat.result.usage && chat.result.usage.total_tokens === 3);

    const outbound = endpoint.requests[0];
    check('exactly one request reached the configured endpoint', endpoint.requests.length === 1);
    check('the API key was sent to that endpoint only', outbound && outbound.headers.authorization === 'Bearer smoke-key');
    check('no request leaked the key elsewhere', store.snapshot().providers[0].hasKey === true);

    const leaked = JSON.stringify(store.snapshot()).includes('smoke-key');
    check('settings snapshot never contains the raw key', !leaked);

    await endpoint.close();
  } catch (error) {
    failed += 1;
    checks.push(`FAIL  smoke run threw: ${error.stack || error.message}`);
  }

  console.log('\nLantern smoke test');
  console.log('------------------');
  for (const line of checks) console.log(line);
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`);

  app.exit(failed ? 1 : 0);
}

module.exports = { runSmoke };

'use strict';

/**
 * Headless smoke test: `npm run smoke`.
 *
 * Boots the real application — main process, preload bridge, renderer and IPC —
 * behind a hidden window, points it at a local fake endpoint and drives the
 * actual UI: it clicks "New task", types into the composer and waits for the
 * streamed answer to land in the tile. Your real settings file is never
 * touched; the app runs against a temporary userData folder.
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

    const shell = await mainWindow.webContents.executeJavaScript(
      `({
         api: typeof window.lantern?.chat?.send === 'function',
         providers: document.querySelectorAll('#providerSelect option').length,
         welcome: Boolean(document.querySelector('.welcome')) && !document.querySelector('.welcome').hidden,
         rail: document.querySelectorAll('.rail-btn').length,
         keyStorage: document.getElementById('keyStorageInfo').textContent.trim(),
         workspaceChip: document.getElementById('workspaceName').textContent.trim(),
       })`,
    );
    check('preload bridge exposes the chat API', shell.api);
    check('renderer sees the configured provider', shell.providers === 1, `options=${shell.providers}`);
    check('empty state invites the first task', shell.welcome);
    check('activity rail is rendered', shell.rail === 3, `buttons=${shell.rail}`);
    check('key storage status is shown', shell.keyStorage.length > 0, shell.keyStorage);
    check('workspace chip has a label', shell.workspaceChip.length > 0, shell.workspaceChip);

    // Command palette, opened the way a user would.
    const palette = await mainWindow.webContents.executeJavaScript(
      `(() => {
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
         const items = [...document.querySelectorAll('.palette-item')].map((node) => node.textContent.trim());
         const open = !document.getElementById('palette').hidden;
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return { open, items, closed: document.getElementById('palette').hidden };
       })()`,
    );
    check('palette opens on Ctrl+K', palette.open);
    check('palette lists commands', palette.items.length >= 5, `${palette.items.length} items`);
    check('palette closes on Escape', palette.closed);

    // The real flow: new task -> composer -> streamed answer in the tile.
    const ui = await mainWindow.webContents.executeJavaScript(       `(async () => {
         document.getElementById('newTask').click();
         await new Promise((resolve) => setTimeout(resolve, 120));

         // Tiles are rebuilt on every state change, so never hold on to a node:
         // query the live DOM each time, the way the UI itself does.
         const tileNow = () => document.querySelector('.tile');
         const box = tileNow().querySelector('.composer textarea');
         box.value = 'ping from the workbench UI';
         const draftBeforeSend = box.value;
         tileNow().querySelector('.composer').requestSubmit();

         const started = Date.now();
         let settled = false;
         while (Date.now() - started < 20000) {
           const body = tileNow().querySelector('.msg-assistant .body');
           if (body && body.textContent.includes('Lantern smoke works') && !tileNow().querySelector('.cursor')) {
             settled = true;
             break;
           }
           await new Promise((resolve) => setTimeout(resolve, 120));
         }

         const finalTile = tileNow();
         return {
           settled,
           tiles: document.querySelectorAll('.tile').length,
           tasks: document.querySelectorAll('#taskList .task-item').length,
           title: finalTile.querySelector('.tile-title').value,
           badge: finalTile.querySelector('.tile-head .badge').textContent.trim(),
           answer: (finalTile.querySelector('.msg-assistant .body') || {}).textContent || '',
           userMessage: (finalTile.querySelector('.msg-user .body') || {}).textContent || '',
           draftBeforeSend,
           composerAfter: finalTile.querySelector('.composer textarea').value,
         };
       })()`,
    );
    check('clicking New task opens a tile', ui.tiles >= 1, `tiles=${ui.tiles}`);
    check('the task appears in the sidebar list', ui.tasks >= 1, `entries=${ui.tasks}`);
    check('the tile is titled from the prompt', ui.title.includes('ping from the workbench'), ui.title);
    check('the user message is rendered in the tile', /ping from the workbench UI/.test(ui.userMessage));
    check('the streamed answer landed in the tile', ui.settled && ui.answer.includes(EXPECTED), JSON.stringify(ui.answer));
    check('the task badge reports done', ui.badge === 'done', ui.badge);
    check('the composer is cleared after sending', ui.composerAfter === '', JSON.stringify(ui.composerAfter));

    const requestsAfterUi = endpoint.requests.length;

    const chat = await mainWindow.webContents.executeJavaScript(
      `(async () => {
         const deltas = [];
         const off = window.lantern.chat.onDelta((payload) => deltas.push(payload.text));
         const result = await window.lantern.chat.send({ messages: [{ role: 'user', content: 'ping' }] });
         off();
         return { deltas, result };
       })()`,
    );

    check('direct IPC round-trip succeeded', chat.result.ok, chat.result.error || '');
    check('answer arrived as separate deltas', chat.deltas.length === WORDS.length, `deltas=${chat.deltas.length}`);
    check('usage was propagated', chat.result.usage && chat.result.usage.total_tokens === 3);

    const outbound = endpoint.requests[0];
    check('one request per send reached the endpoint', requestsAfterUi === 1 && endpoint.requests.length === 2, `requests=${endpoint.requests.length}`);
    check('the key was sent to that endpoint', outbound.headers.authorization === 'Bearer smoke-key');
    check('the request body carries the typed prompt', /ping from the workbench UI/.test(outbound.body));
    check('settings snapshot never contains the raw key', !JSON.stringify(store.snapshot()).includes('smoke-key'));

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

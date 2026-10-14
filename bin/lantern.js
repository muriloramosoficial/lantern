#!/usr/bin/env node
'use strict';

/**
 * Lantern CLI.
 *
 *   lantern            launch the desktop app (installs on first run)
 *   lantern install    download the latest release and install it
 *   lantern status     show where the app is installed
 *   lantern open <dir> launch with a workspace folder already selected
 *   lantern version    print versions
 *
 * The npm package is a thin launcher: the desktop app itself is the small
 * Electron bundle published on GitHub Releases. Nothing here phones home.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

const OWNER = 'muriloramosoficial';
const REPO = 'lantern';
const APP_NAME = 'Lantern';
const VERSION = require('../package.json').version;

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const home = os.homedir();

const INSTALL_DIR = isWin
  ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME)
  : isMac
    ? path.join(home, 'Applications', APP_NAME)
    : path.join(home, '.local', 'share', APP_NAME.toLowerCase());

const LAUNCHERS = isWin
  ? [path.join(INSTALL_DIR, 'Lantern.exe')]
  : isMac
    ? [path.join(INSTALL_DIR, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME)]
    : [path.join(home, '.local', 'bin', 'lantern')];

const COLORS = process.stdout.isTTY
  ? { dim: '\u001b[2m', ok: '\u001b[32m', warn: '\u001b[33m', err: '\u001b[31m', accent: '\u001b[38;5;214m', reset: '\u001b[0m' }
  : { dim: '', ok: '', warn: '', err: '', accent: '', reset: '' };

const say = (message) => console.log(message);
const dim = (message) => say(`${COLORS.dim}${message}${COLORS.reset}`);
const ok = (message) => say(`${COLORS.ok}${message}${COLORS.reset}`);
const warn = (message) => say(`${COLORS.warn}${message}${COLORS.reset}`);
const fail = (message) => console.error(`${COLORS.err}${message}${COLORS.reset}`);

function banner() {
  say(`${COLORS.accent}  Lantern${COLORS.reset} ${COLORS.dim}v${VERSION} – local-first AI workbench${COLORS.reset}`);
}

function findInstall() {
  for (const candidate of LAUNCHERS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': `lantern-cli/${VERSION}` } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          return getJson(response.headers.location).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`GitHub answered HTTP ${response.statusCode} for ${url}`));
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    https
      .get(url, { headers: { 'user-agent': `lantern-cli/${VERSION}`, accept: 'application/octet-stream' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          return download(response.headers.location, destination, redirects + 1).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        }

        const total = Number(response.headers['content-length'] || 0);
        let received = 0;
        let lastTick = 0;
        const stream = fs.createWriteStream(destination);

        response.on('data', (chunk) => {
          received += chunk.length;
          if (total && Date.now() - lastTick > 400) {
            lastTick = Date.now();
            const percent = Math.floor((received / total) * 100);
            process.stdout.write(`\r  ${COLORS.dim}downloading… ${percent}% (${(received / 1048576).toFixed(1)} MB)${COLORS.reset}   `);
          }
        });
        response.pipe(stream);
        stream.on('finish', () => {
          if (total) process.stdout.write('\r'.padEnd(60) + '\r');
          stream.close(() => resolve(destination));
        });
        stream.on('error', reject);
      })
      .on('error', reject);
  });
}

function pickAsset(release) {
  const assets = release.assets || [];
  const patterns = isWin
    ? [/Setup.*\.exe$/i, /Portable.*\.exe$/i, /\.exe$/i]
    : isMac
      ? [/\.dmg$/i, /\.zip$/i]
      : [/\.AppImage$/i, /\.deb$/i];

  for (const pattern of patterns) {
    const match = assets.find((asset) => pattern.test(asset.name));
    if (match) return match;
  }
  return null;
}

async function install({ silent = false } = {}) {
  banner();
  dim(`  looking up the latest release of ${OWNER}/${REPO}…`);

  let release;
  try {
    release = await getJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
  } catch (error) {
    fail(`\n  Could not reach GitHub: ${error.message}`);
    say('');
    say('  You can also install manually:');
    say(`    https://github.com/${OWNER}/${REPO}/releases`);
    process.exitCode = 1;
    return;
  }

  const asset = pickAsset(release);
  if (!asset) {
    fail(`\n  Release ${release.tag_name || ''} has no installer for ${process.platform}.`);
    say(`  Build from source instead: git clone https://github.com/${OWNER}/${REPO} && npm install && npm run dist`);
    process.exitCode = 1;
    return;
  }

  const tempFile = path.join(os.tmpdir(), asset.name);
  ok(`  release ${release.tag_name}`);
  await download(asset.browser_download_url, tempFile);

  if (isWin && /setup.*\.exe$/i.test(asset.name)) {
    dim('  running the installer (silent)…');
    const result = spawnSync(tempFile, ['/S'], { stdio: 'inherit' });
    if (result.status !== 0 && result.status !== 3010) {
      warn(`  Installer exited with code ${result.status}. The app may still be installed; run "lantern status".`);
    }
  } else if (isWin) {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    const target = path.join(INSTALL_DIR, 'Lantern.exe');
    fs.copyFileSync(tempFile, target);
  } else if (isMac && /\.dmg$/i.test(asset.name)) {
    dim('  mounting the disk image…');
    const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-dmg-'));
    const attach = spawnSync('hdiutil', ['attach', tempFile, '-nobrowse', '-mountpoint', mountPoint], {
      encoding: 'utf8',
    });
    if (attach.status !== 0) {
      warn(`  Could not mount the image automatically (${attach.status}).`);
      say(`  Open it manually: open "${tempFile}"`);
      return;
    }
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    spawnSync('cp', ['-R', path.join(mountPoint, `${APP_NAME}.app`), INSTALL_DIR], { stdio: 'inherit' });
    spawnSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'inherit' });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  } else if (/\.deb$/i.test(asset.name)) {
    say(`  Install with: sudo dpkg -i "${tempFile}"`);
    return;
  } else {
    fs.mkdirSync(path.dirname(LAUNCHERS[0]), { recursive: true });
    fs.copyFileSync(tempFile, LAUNCHERS[0]);
    fs.chmodSync(LAUNCHERS[0], 0o755);
  }

  fs.rmSync(tempFile, { force: true });
  ok(`\n  ${APP_NAME} installed.`);
  if (!silent) say('  Launch it with:  lantern');
}

function launch(workspace) {
  const launcher = findInstall();

  if (!launcher) {
    warn(`\n  ${APP_NAME} is not installed yet.\n`);
    say(`  Run:  lantern install`);
    say(`  Or:   irm https://raw.githubusercontent.com/${OWNER}/${REPO}/main/scripts/install.ps1 | iex`);
    process.exitCode = 1;
    return;
  }

  const args = workspace ? [path.resolve(workspace)] : [];
  const child = spawn(launcher, args, { detached: true, stdio: 'ignore' });
  child.unref();
  ok(`${APP_NAME} started.`);
}

function status() {
  banner();
  const launcher = findInstall();
  if (launcher) ok(`  installed: ${launcher}`);
  else warn(`  not installed – run: lantern install`);
  say(`${COLORS.dim}  settings and keys live in the app's own userData folder, never in this package.${COLORS.reset}`);
}

function help() {
  banner();
  say(`
  Usage
    ${COLORS.accent}lantern${COLORS.reset}                launch the desktop app
    ${COLORS.accent}lantern install${COLORS.reset}        download and install the latest release
    ${COLORS.accent}lantern status${COLORS.reset}         show the current installation
    ${COLORS.accent}lantern open <dir>${COLORS.reset}     launch with a workspace folder
    ${COLORS.accent}lantern version${COLORS.reset}        print versions
    ${COLORS.accent}lantern help${COLORS.reset}           this message

  Other ways to install
    Windows PowerShell   irm https://raw.githubusercontent.com/${OWNER}/${REPO}/main/scripts/install.ps1 | iex
    macOS / Linux        curl -fsSL https://raw.githubusercontent.com/${OWNER}/${REPO}/main/scripts/install.sh | bash
    Installers           https://github.com/${OWNER}/${REPO}/releases

  Source
    git clone https://github.com/${OWNER}/${REPO}
    npm install && npm start

  Lantern has no account, no license server and no telemetry.
`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'run':
    case 'start':
      if (!findInstall()) return install({ silent: true }).then(() => launch(null));
      return launch(null);
    case 'install':
    case 'update':
      return install();
    case 'open':
      return launch(argument);
    case 'status':
      return status();
    case 'version':
    case '--version':
    case '-v':
      return say(VERSION);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      fail(`Unknown command: ${command}`);
      return help();
  }
}

main().catch((error) => {
  fail(error.message);
  process.exitCode = 1;
});

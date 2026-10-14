'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.output', '.parcel-cache', '.turbo',
  '.venv', '.idea', '.vs', '.vscode',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'release', 'coverage', 'target', 'obj', 'bin',
  '__pycache__', 'venv', 'env', 'site-packages',
]);

const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.fs', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.m', '.mm', '.lua', '.pl', '.r', '.jl', '.dart', '.ex', '.exs', '.erl',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.svg', '.xml', '.sql', '.graphql', '.gql',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd', '.env', '.gitignore', '.editorconfig', '.dockerignore',
  '.dockerfile', '.tf', '.tfvars', '.gradle', '.properties', '.lock', '.patch', '.diff', '.csv', '.tsv', '.log',
]);

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_BUDGET_CHARS = 60_000;

/** Resolve a path and guarantee it stays inside the workspace root. */
function resolveInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, target || '.');
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the workspace.');
  }
  return resolved;
}

function isProbablyText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(base)) return true;
  return !ext;
}

function listTree(root, { maxEntries = 4000, maxDepth = 8 } = {}) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) throw new Error('Workspace folder not found.');
  if (!fs.statSync(base).isDirectory()) throw new Error('Workspace path is not a folder.');

  const entries = [];
  let truncated = false;

  const walk = (dir, depth) => {
    if (depth > maxDepth || truncated) return;
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, child.name);
      const rel = path.relative(base, full).split(path.sep).join('/');

      if (child.isDirectory()) {
        if (IGNORED_DIRS.has(child.name) || child.name.startsWith('.')) continue;
        entries.push({ path: rel, type: 'dir' });
        walk(full, depth + 1);
      } else if (child.isFile()) {
        if (IGNORED_FILES.has(child.name)) continue;
        if (!isProbablyText(full)) continue;
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        entries.push({ path: rel, type: 'file', size });
      }
    }
  };

  walk(base, 0);
  return { root: base, name: path.basename(base), entries, truncated, skipped: [...IGNORED_DIRS] };
}

function readTextFile(root, relPath, { maxBytes = MAX_FILE_BYTES } = {}) {
  const full = resolveInside(root, relPath);
  if (!fs.existsSync(full)) throw new Error(`File not found: ${relPath}`);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);

  const limit = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(limit);
  const handle = fs.openSync(full, 'r');
  try {
    fs.readSync(handle, buffer, 0, limit, 0);
  } finally {
    fs.closeSync(handle);
  }

  return {
    path: relPath,
    size: stat.size,
    bytes: limit,
    truncated: stat.size > limit,
    content: buffer.toString('utf8'),
  };
}

/**
 * Build the context block handed to the model. Files are capped per-file and
 * then trimmed as a whole so a request never grows without bound.
 */
function buildContext(root, relPaths, { budgetChars = DEFAULT_BUDGET_CHARS, maxBytes = MAX_FILE_BYTES } = {}) {
  const files = [];
  let used = 0;
  const notes = [];

  for (const relPath of relPaths || []) {
    try {
      const file = readTextFile(root, relPath, { maxBytes });
      const remaining = budgetChars - used;
      if (remaining <= 200) {
        notes.push(`${relPath}: skipped, context budget reached`);
        continue;
      }
      const content = file.content.length > remaining ? file.content.slice(0, remaining) : file.content;
      used += content.length;
      files.push({ path: relPath, content, truncated: file.truncated || content.length < file.content.length });
    } catch (error) {
      notes.push(`${relPath}: ${error.message}`);
    }
  }

  return { files, notes, chars: used };
}

function formatContextBlock(context) {
  if (!context || !context.files.length) return '';
  const parts = context.files.map((file) => {
    const note = file.truncated ? ' (truncated)' : '';
    return `--- FILE: ${file.path}${note} ---\n${file.content}`;
  });
  return `Workspace files attached by the user:\n\n${parts.join('\n\n')}`;
}

module.exports = {
  DEFAULT_BUDGET_CHARS,
  IGNORED_DIRS,
  MAX_FILE_BYTES,
  TEXT_EXTENSIONS,
  buildContext,
  formatContextBlock,
  isProbablyText,
  listTree,
  readTextFile,
  resolveInside,
};

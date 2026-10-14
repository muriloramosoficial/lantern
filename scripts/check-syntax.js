#!/usr/bin/env node
'use strict';

/** Runs `node --check` over every JavaScript file in the project. */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOTS = ['src', 'bin', 'scripts', 'test'];
const SKIP_DIRS = new Set(['node_modules', 'release', '.git', 'out']);

function collect(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, files);
    else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = ROOTS.flatMap((root) => collect(root));
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) {
    process.stdout.write(`ok   ${file}\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL ${file}\n${result.stderr.trim()}\n`);
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} files parsed\n`);
process.exitCode = failed ? 1 : 0;

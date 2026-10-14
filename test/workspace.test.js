'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildContext, formatContextBlock, listTree, readTextFile, resolveInside } = require('../src/main/workspace');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-ws-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const answer = 42;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n', 'utf8');
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  return root;
}

test('listTree skips noise folders and binary files', () => {
  const root = makeProject();
  const tree = listTree(root);
  const paths = tree.entries.map((entry) => entry.path);

  assert.ok(paths.includes('src/app.js'));
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('README.md'));
  assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules must be skipped');
  assert.ok(!paths.some((p) => p.startsWith('.git')), '.git must be skipped');
  assert.ok(!paths.includes('logo.png'), 'binary files must be skipped');
});

test('readTextFile reports truncation instead of blowing up on big files', () => {
  const root = makeProject();
  const small = readTextFile(root, 'README.md');
  assert.equal(small.content, '# Demo\n');
  assert.equal(small.truncated, false);

  const bigPath = path.join(root, 'big.txt');
  fs.writeFileSync(bigPath, 'x'.repeat(5000), 'utf8');
  const big = readTextFile(root, 'big.txt', { maxBytes: 100 });
  assert.equal(big.content.length, 100);
  assert.equal(big.truncated, true);
  assert.equal(big.size, 5000);

  assert.throws(() => readTextFile(root, 'missing.txt'), /not found/i);
});

test('paths cannot escape the workspace', () => {
  const root = makeProject();
  assert.throws(() => resolveInside(root, '../../etc/passwd'), /outside the workspace/i);
  assert.throws(() => readTextFile(root, '../secrets.txt'), /outside the workspace/i);
  assert.equal(resolveInside(root, 'src/app.js'), path.join(root, 'src', 'app.js'));
});

test('buildContext trims to the budget and reports what was skipped', () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'big.txt'), 'y'.repeat(4000), 'utf8');

  const context = buildContext(root, ['big.txt', 'README.md', 'nope.js'], { budgetChars: 1500 });

  assert.equal(context.files.length, 1);
  assert.equal(context.files[0].path, 'big.txt');
  assert.equal(context.files[0].content.length, 1500);
  assert.equal(context.files[0].truncated, true);
  assert.equal(context.chars, 1500);
  assert.ok(context.notes.some((note) => /README\.md: skipped/.test(note)), 'budget skip is reported');
  assert.ok(context.notes.some((note) => note.startsWith('nope.js')), 'unreadable file is reported');

  const block = formatContextBlock(context);
  assert.match(block, /--- FILE: big\.txt \(truncated\) ---/);
});

test('files that fit are attached untrimmed with their real content', () => {
  const root = makeProject();
  const context = buildContext(root, ['src/app.js', 'README.md']);

  assert.deepEqual(context.files.map((file) => file.path), ['src/app.js', 'README.md']);
  assert.equal(context.files[0].truncated, false);
  assert.match(formatContextBlock(context), /const answer = 42/);
});

test('an empty attachment list produces no context block', () => {
  const root = makeProject();
  const context = buildContext(root, []);
  assert.equal(context.files.length, 0);
  assert.equal(formatContextBlock(context), '');
});

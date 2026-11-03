// 実行: node --test test/home-path.test.js
// タスクキューのパス（/api/state の tasksPath）の ~ 短縮（Issue #1 の指摘 16）。
// 短縮はサーバー側で HOME を基準に行う（画面側で /Users/ を決め打ちすると、Linux の /home/... などで短縮されないため）。
// bin/takt-dashboard を子プロセスで起動し、/api/state で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

// HOME と比べるのは文字列なので、実パスにそろえる（macOS の /var → /private/var のようなシンボリックリンクで食い違わないように）
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const CWD = path.join(ROOT, 'cwd'); // run は置かない
// HOME 配下のリポジトリ
const IN_HOME = path.join(HOME, 'repo');
// HOME そのものがリポジトリのルート（tasks.yaml は ~/.takt/tasks.yaml）
const AT_HOME = HOME;
// HOME の外のリポジトリ
const OUTSIDE = path.join(ROOT, 'outside', 'repo');
// HOME と文字列の先頭だけが一致する別ディレクトリ（<tmp>/home に対する <tmp>/homebar）
const PREFIX_ONLY = path.join(ROOT, 'homebar', 'repo');

const runDirOf = (root, slug) => path.join(root, '.takt', 'runs', slug);
const RUNS = {
  inHome: runDirOf(IN_HOME, '20261029-100000-in-home'),
  atHome: runDirOf(AT_HOME, '20261029-110000-at-home'),
  outside: runDirOf(OUTSIDE, '20261029-120000-outside'),
  prefixOnly: runDirOf(PREFIX_ONLY, '20261029-130000-prefix-only'),
};

function writeRun(root, runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: path.basename(runDir), currentStep: 'plan', startTime: '2026-10-29T01:00:00.000Z', updatedAt: '2026-10-29T01:00:10.000Z' }));
  fs.writeFileSync(path.join(root, '.takt', 'tasks.yaml'), 'tasks:\n');
}

let server;

before(async () => {
  fs.mkdirSync(CWD, { recursive: true });
  writeRun(IN_HOME, RUNS.inHome);
  writeRun(AT_HOME, RUNS.atHome);
  writeRun(OUTSIDE, RUNS.outside);
  writeRun(PREFIX_ONLY, RUNS.prefixOnly);
  server = await startDashboard({ cwd: CWD, home: HOME });
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const getState = async (runDir) => {
  const res = await fetch(server.base + '/api/state?run=' + encodeURIComponent(runDir));
  assert.equal(res.status, 200);
  return res.json();
};

test('HOME 配下の tasks.yaml は、HOME を ~ に置き換えたパスで返す', async () => {
  const st = await getState(RUNS.inHome);
  assert.equal(st.active.runDir, RUNS.inHome, '指定した run を開いている（前提）');
  assert.equal(st.tasksPath, '~' + path.sep + path.join('repo', '.takt', 'tasks.yaml'));
});

test('リポジトリのルートが HOME そのものなら、~/.takt/tasks.yaml で返す', async () => {
  const st = await getState(RUNS.atHome);
  assert.equal(st.active.runDir, RUNS.atHome, '指定した run を開いている（前提）');
  assert.equal(st.tasksPath, '~' + path.sep + path.join('.takt', 'tasks.yaml'));
});

test('HOME の外の tasks.yaml は、短縮せず絶対パスのまま返す', async () => {
  const st = await getState(RUNS.outside);
  assert.equal(st.active.runDir, RUNS.outside, '指定した run を開いている（前提）');
  assert.equal(st.tasksPath, path.join(OUTSIDE, '.takt', 'tasks.yaml'));
});

test('HOME と文字列の先頭だけが一致する別ディレクトリ（<HOME>bar/...）は、短縮せず絶対パスのまま返す', async () => {
  const st = await getState(RUNS.prefixOnly);
  assert.equal(st.active.runDir, RUNS.prefixOnly, '指定した run を開いている（前提）');
  assert.equal(st.tasksPath, path.join(PREFIX_ONLY, '.takt', 'tasks.yaml'));
});

test('リポジトリ名（repo）は短縮の影響を受けず、tasks.yaml の置き場のディレクトリ名のまま', async () => {
  assert.equal((await getState(RUNS.inHome)).repo, 'repo');
  assert.equal((await getState(RUNS.atHome)).repo, path.basename(HOME));
});

// 実行: node --test test/run-record.test.js
// run の記録（root と中断判定）が、一覧（findRuns）経由・?run= で一覧に無い run を開く経路・<run_dir> 固定のどれでも同じになること（Issue #1 の指摘 4）。
// bin/takt-dashboard を子プロセスで起動し、/api/state の active.root と active.meta.status で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

// tasks.yaml の worktree_path と root を文字列で比べるので、期待値も実パスにそろえる
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo'); // cwd。run は置かない（WT_* の run が一覧に入らないように）
// 中断扱いになる worktree: meta.json は running、tasks.yaml の対応するタスクは completed
const WT_INT = path.join(ROOT, 'wt-int');
const INT_RUN = path.join(WT_INT, '.takt', 'runs', '20261029-100000-int');
// 実行中のままの worktree: tasks.yaml のタスクも running で、owner_pid は生きている（このテストのプロセス）、run_slug も同じ
const WT_RUN = path.join(ROOT, 'wt-run');
const RUNNING_RUN = path.join(WT_RUN, '.takt', 'runs', '20261029-110000-running');
// Web UI（takt ui）の run: ~/.takt/state/projects/<id>/runs に書かれ、root は state.json の canonicalDirectory
const CANON = path.join(ROOT, 'canon');
const UI_PROJ = path.join(HOME, '.takt', 'state', 'projects', 'p1');
const UI_RUN = path.join(UI_PROJ, 'runs', '20261029-090000-ui');

function writeRun(runDir, meta) {
  fs.mkdirSync(runDir, { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ currentStep: 'plan', startTime: meta.updatedAt, ...meta }));
}

function writeTasks(worktree, task) {
  const lines = ['tasks:', '  - name: t', ...Object.entries({ ...task, worktree_path: worktree }).map(([k, v]) => '    ' + k + ': ' + v)];
  fs.writeFileSync(path.join(worktree, '.takt', 'tasks.yaml'), lines.join('\n') + '\n');
}

const startServer = (args) => startDashboard({ cwd: REPO, home: HOME, args });
const stopServer = stopDashboard;

const getState = async (server, query = '') => (await fetch(server.base + '/api/state' + query)).json();
const runParam = (runDir) => '?run=' + encodeURIComponent(runDir);
// 経路ごとの比較に使う値。root と中断判定の結果（status）
const record = (body) => ({ root: body.active?.root, status: body.active?.meta?.status });

let plain; // <run_dir> なし、--roots なし（WT_* の run は一覧に無い）
let listed; // --roots で WT_INT・WT_RUN を一覧に入れる
let fixedInt; // <run_dir> に INT_RUN
let fixedRunning; // <run_dir> に RUNNING_RUN
let fixedUi; // <run_dir> に UI_RUN
const servers = []; // 起動できたサーバ。after() で全部止める

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(CANON, { recursive: true });
  writeRun(INT_RUN, { status: 'running', runSlug: '20261029-100000-int', updatedAt: '2026-10-29T10:00:00.000Z' });
  writeTasks(WT_INT, { status: 'completed', run_slug: '20261029-100000-int' });
  writeRun(RUNNING_RUN, { status: 'running', runSlug: '20261029-110000-running', updatedAt: '2026-10-29T11:00:00.000Z' });
  writeTasks(WT_RUN, { status: 'running', owner_pid: process.pid, run_slug: '20261029-110000-running' });
  fs.mkdirSync(UI_PROJ, { recursive: true });
  fs.writeFileSync(path.join(UI_PROJ, 'state.json'), JSON.stringify({ canonicalDirectory: CANON }));
  writeRun(UI_RUN, { status: 'completed', runSlug: '20261029-090000-ui', task: '# UI のタスク', updatedAt: '2026-10-29T09:00:00.000Z' });
  // allSettled で全部の起動を待ってから、起動できたものを記録する（1 つ失敗しても、起動済みのものを after() で止められるように）
  const results = await Promise.allSettled([
    startServer([]),
    startServer(['--roots', WT_INT + ',' + WT_RUN]),
    startServer([INT_RUN]),
    startServer([RUNNING_RUN]),
    startServer([UI_RUN]),
  ]);
  servers.push(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  [plain, listed, fixedInt, fixedRunning, fixedUi] = results.map((r) => r.value);
});

after(async () => {
  await Promise.all(servers.map(stopServer));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('REC-LISTED: 一覧経由では、tasks.yaml のタスクが終わった running の run は中断になり、root は worktree になる', async () => {
  // 前提の確認: 一覧に入っていること
  const body = await getState(listed, runParam(INT_RUN));
  assert.ok(body.runs.some((r) => r.runDir === INT_RUN));
  assert.deepEqual(record(body), { root: WT_INT, status: 'interrupted' });
});

test('REC-INT-RUNPARAM: ?run= で一覧に無い run を開いても、一覧経由と同じ root と中断判定になる', async () => {
  const body = await getState(plain, runParam(INT_RUN));
  assert.equal(body.runsTotal, 1); // 前提の確認: plain の一覧は UI の run だけで、INT_RUN は探索で見つかっていない
  assert.deepEqual(record(body), record(await getState(listed, runParam(INT_RUN))));
  assert.deepEqual(record(body), { root: WT_INT, status: 'interrupted' });
});

test('REC-INT-FIXED: <run_dir> で起動しても、一覧経由と同じ root と中断判定になる', async () => {
  const body = await getState(fixedInt);
  assert.equal(body.active.runDir, INT_RUN);
  assert.deepEqual(record(body), { root: WT_INT, status: 'interrupted' });
});

test('REC-INT-NEG: tasks.yaml のタスクが実行中（owner_pid が生存・run_slug が同じ）の run は、どの経路でも running のまま', async () => {
  for (const body of [await getState(listed, runParam(RUNNING_RUN)), await getState(plain, runParam(RUNNING_RUN)), await getState(fixedRunning)]) {
    assert.deepEqual(record(body), { root: WT_RUN, status: 'running' });
  }
});

test('REC-ROOT-FIXED-UI: <run_dir> に Web UI の run を渡すと、一覧経由と同じく root は state.json の canonicalDirectory になる', async () => {
  const viaList = await getState(plain, runParam(UI_RUN));
  assert.ok(viaList.runs.some((r) => r.runDir === UI_RUN)); // 前提の確認: UI の run は一覧に入る
  assert.equal(viaList.active.root, CANON);
  const body = await getState(fixedUi);
  assert.equal(body.active.runDir, UI_RUN);
  assert.equal(body.active.root, CANON);
  assert.deepEqual(record(body), record(viaList));
});

// 実行: node --test test/task-status.test.js
// タスクキューの中断表示（/api/state の currentTask.status）と、タイムラインの中断・失敗の終了行（kind: 'end'）が変わらないこと（Issue #1 の指摘 8・9）。
// bin/takt-dashboard を子プロセスで起動し、/api/state で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/takt-dashboard', import.meta.url));

// tasks.yaml の worktree_path と root を文字列で比べるので、実パスにそろえる
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo'); // cwd。run は置かない
// 中断した worktree: meta.json も tasks.yaml のタスクも running のまま、owner_pid は終了済みのプロセス
const WT_DEAD = path.join(ROOT, 'wt-dead');
const DEAD_RUN = path.join(WT_DEAD, '.takt', 'runs', '20261029-100000-dead');
// 実行中の worktree: tasks.yaml のタスクは running で、owner_pid は生きている（このテストのプロセス）
const WT_LIVE = path.join(ROOT, 'wt-live');
const LIVE_RUN = path.join(WT_LIVE, '.takt', 'runs', '20261029-110000-live');
// 失敗した worktree: meta.json は failed。tasks.yaml のタスクは failed で、owner_pid は終了済みのプロセス
const WT_FAIL = path.join(ROOT, 'wt-fail');
const FAIL_RUN = path.join(WT_FAIL, '.takt', 'runs', '20261029-120000-fail');
// 完了した worktree: meta.json は completed
const WT_DONE = path.join(ROOT, 'wt-done');
const DONE_RUN = path.join(WT_DONE, '.takt', 'runs', '20261029-130000-done');

// /api/state の currentTask のキーと順番（owner_pid は応答に含めない）
const TASK_KEYS = ['raw', 'worktree_path', 'branch', 'run_slug', 'name', 'status', 'workflow', 'issue', 'summary', 'created_at', 'completed_at'];

function writeRun(runDir, meta, events) {
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ currentStep: 'develop', startTime: meta.updatedAt, ...meta }));
  fs.writeFileSync(path.join(runDir, 'logs', 'a.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeTasks(worktree, task) {
  const lines = ['tasks:', '  - name: t', ...Object.entries({ ...task, worktree_path: worktree }).map(([k, v]) => '    ' + k + ': ' + v)];
  fs.writeFileSync(path.join(worktree, '.takt', 'tasks.yaml'), lines.join('\n') + '\n');
}

// 終了済みのプロセスの pid（起動して終了を待つ）
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(extraArgs) {
  const port = await freePort();
  const env = { ...process.env, HOME };
  delete env.TAKT_DASHBOARD_ROOTS;
  delete env.TAKT_DASHBOARD_PORT;
  const child = spawn(process.execPath, [BIN, '--port', String(port), ...extraArgs], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('takt-dashboard が起動しない: ' + stderr)), 10000);
      let stdout = ''; // 起動メッセージが複数の data に分かれても見つけられるよう、連結してから探す
      child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('takt-dashboard: http://localhost:')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('takt-dashboard が起動前に終了した (code ' + code + '): ' + stderr)); });
    });
  } catch (e) {
    await stopServer({ child }); // 起動待ちで失敗しても子プロセスを残さない（残るとテストが終わらない）
    throw e;
  }
  return { child, base: 'http://127.0.0.1:' + port };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return; // シグナルで終了済みなら exitCode は null のまま
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
}

const getState = async (query = '') => (await fetch(server.base + '/api/state' + query)).json();
const runParam = (runDir) => '?run=' + encodeURIComponent(runDir);
const endRows = (body) => body.timeline.filter((r) => r.kind === 'end');

let server; // --roots で WT_* を一覧に入れる

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(REPO, { recursive: true });
  const dead = await deadPid();
  writeRun(DEAD_RUN, { status: 'running', runSlug: '20261029-100000-dead', updatedAt: '2026-10-29T10:05:00.000Z' }, [
    { type: 'step_start', step: 'plan', iteration: 1, timestamp: '2026-10-29T10:00:01.000Z' },
  ]);
  writeTasks(WT_DEAD, { status: 'running', owner_pid: dead, run_slug: '20261029-100000-dead' });
  writeRun(LIVE_RUN, { status: 'running', runSlug: '20261029-110000-live', updatedAt: '2026-10-29T11:05:00.000Z' }, [
    { type: 'step_start', step: 'plan', iteration: 1, timestamp: '2026-10-29T11:00:01.000Z' },
  ]);
  writeTasks(WT_LIVE, { status: 'running', owner_pid: process.pid, run_slug: '20261029-110000-live' });
  writeRun(FAIL_RUN, {
    status: 'failed', runSlug: '20261029-120000-fail', updatedAt: '2026-10-29T12:05:00.000Z', endTime: '2026-10-29T12:04:00.000Z',
    failure: { step: 'plan' }, reason: 'Step "plan" failed: boom',
  }, [
    { type: 'step_start', step: 'plan', iteration: 1, timestamp: '2026-10-29T12:00:01.000Z' },
    { type: 'phase_judge_stage', step: 'plan', iteration: 1, stage: 1, method: 'structured_output', status: 'error', response: 'no match', timestamp: '2026-10-29T12:00:02.000Z' },
    { type: 'step_complete', step: 'plan', iteration: 1, status: 'error', content: 'boom', timestamp: '2026-10-29T12:00:03.000Z' },
  ]);
  writeTasks(WT_FAIL, { status: 'failed', owner_pid: dead, run_slug: '20261029-120000-fail' });
  writeRun(DONE_RUN, { status: 'completed', runSlug: '20261029-130000-done', updatedAt: '2026-10-29T13:05:00.000Z', endTime: '2026-10-29T13:04:00.000Z' }, [
    { type: 'step_start', step: 'plan', iteration: 1, timestamp: '2026-10-29T13:00:01.000Z' },
    { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', timestamp: '2026-10-29T13:00:03.000Z' },
  ]);
  server = await startServer(['--roots', [WT_DEAD, WT_LIVE, WT_FAIL, WT_DONE].join(',')]);
});

after(async () => {
  await stopServer(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('タスクキュー: running で owner_pid が終了済みのタスクは interrupted と表示され、応答のキーは今と同じ', async () => {
  const body = await getState(runParam(DEAD_RUN));
  assert.equal(body.currentTask.status, 'interrupted');
  assert.deepEqual(Object.keys(body.currentTask), TASK_KEYS);
});

test('タスクキュー: running で owner_pid が生きているタスクは running のまま', async () => {
  const body = await getState(runParam(LIVE_RUN));
  assert.equal(body.currentTask.status, 'running');
  assert.deepEqual(Object.keys(body.currentTask), TASK_KEYS);
});

test('タスクキュー: running 以外のタスクは owner_pid が終了済みでも tasks.yaml の status のまま', async () => {
  const body = await getState(runParam(FAIL_RUN));
  assert.equal(body.currentTask.status, 'failed');
});

test('run の中断表示: owner_pid が終了済みの run は active.meta.status と runs[].status の両方で interrupted', async () => {
  const body = await getState(runParam(DEAD_RUN));
  assert.equal(body.active.meta.status, 'interrupted');
  assert.equal(body.runs.find((r) => r.runDir === DEAD_RUN)?.status, 'interrupted');
  assert.equal(body.runs.find((r) => r.runDir === LIVE_RUN)?.status, 'running');
});

test('タイムライン: 中断した run は、最後の行が中断の終了行になる', async () => {
  const body = await getState(runParam(DEAD_RUN));
  assert.equal(endRows(body).length, 1);
  assert.deepEqual(body.timeline.at(-1), { ts: '2026-10-29T10:05:00.000Z', kind: 'end', status: 'interrupted', step: 'plan の実行中' });
});

test('タイムライン: 失敗した run は、最後の行が失敗の終了行になる（理由の前置きを落とし、最後の試行の判定を付ける）', async () => {
  const body = await getState(runParam(FAIL_RUN));
  assert.equal(endRows(body).length, 1);
  assert.deepEqual(body.timeline.at(-1), {
    ts: '2026-10-29T12:04:00.000Z', kind: 'end', status: 'failed', step: 'plan', key: 'plan#1', reason: 'boom',
    judge: { label: null, stages: [{ stage: 1, method: 'structured_output', status: 'error', response: 'no match' }] },
  });
});

test('タイムライン: 実行中・完了した run には終了行が無い', async () => {
  assert.deepEqual(endRows(await getState(runParam(LIVE_RUN))), []);
  assert.deepEqual(endRows(await getState(runParam(DONE_RUN))), []);
});

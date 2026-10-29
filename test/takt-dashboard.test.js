// bin/takt-dashboard を子プロセスとして起動し、HTTP と終了コードで振る舞いを確かめる。
// 実行: node --test test/takt-dashboard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'takt-dashboard');
const STARTUP_TIMEOUT_MS = 5000;

// 実際の ~/.takt や ~/.config/takt-dashboard を読ませないよう、HOME と cwd を一時ディレクトリにする
function makeSandbox(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRun(runDir, meta = { status: 'completed', runSlug: path.basename(runDir) }) {
  mkdirSync(path.join(runDir, 'reports'), { recursive: true });
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta));
  return runDir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function spawnDashboard(t, sandbox, extraArgs, port) {
  const env = { ...process.env, HOME: sandbox, PATH: '', TAKT_DASHBOARD_ROOTS: '' };
  delete env.TAKT_DASHBOARD_PORT;
  const proc = spawn(process.execPath, [BIN, ...extraArgs, '--port', String(port)], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  proc.stdout.on('data', (d) => { out.stdout += d; });
  proc.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  return { proc, out, exited };
}

// 起動メッセージが出るまで待つ。先に終了したら、その時点の出力を添えて失敗させる
async function startDashboard(t, sandbox, extraArgs = []) {
  const port = await freePort();
  const d = spawnDashboard(t, sandbox, extraArgs, port);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('起動待ちがタイムアウト: ' + JSON.stringify(d.out))), STARTUP_TIMEOUT_MS);
    const check = () => { if (d.out.stdout.includes('http://localhost:' + port)) { clearTimeout(timer); resolve(); } };
    d.proc.stdout.on('data', check);
    d.exited.then((r) => { clearTimeout(timer); reject(new Error('起動前に終了: ' + JSON.stringify({ ...r, ...d.out }))); });
    check();
  });
  return { ...d, base: 'http://127.0.0.1:' + port };
}

// 起動時に終了することを期待するケース。時間内に終わらなければ kill して「終了しなかった」と分かる結果を返す
async function runUntilExit(t, sandbox, extraArgs) {
  const port = await freePort();
  const d = spawnDashboard(t, sandbox, extraArgs, port);
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), STARTUP_TIMEOUT_MS));
  const r = await Promise.race([d.exited, timeout]);
  if (r === 'timeout') { d.proc.kill('SIGKILL'); await d.exited; return { code: null, timedOut: true, ...d.out }; }
  return { code: r.code, timedOut: false, ...d.out };
}

const isAlive = (proc) => proc.exitCode === null && proc.signalCode === null;

// ---------- 指摘 1: /api/report にディレクトリを渡す ----------

test('/api/report にディレクトリを渡すと 404 not found を返し、プロセスは応答を続ける', async (t) => {
  // Given: reports/ 配下にサブディレクトリがある run を位置引数で開いたサーバー
  const sandbox = makeSandbox(t);
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-dir-report'));
  mkdirSync(path.join(runDir, 'reports', 'sub'));
  const s = await startDashboard(t, sandbox, [runDir]);

  // When: レポートとしてサブディレクトリを要求する
  const res = await fetch(s.base + '/api/report?p=sub');

  // Then: 404・text/plain・not found。プロセスは生きていて次の要求にも応答する
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'not found');
  const next = await fetch(s.base + '/api/state');
  assert.equal(next.status, 200);
  assert.ok(isAlive(s.proc));
});

// ---------- 指摘 1: ハンドラ内の例外 ----------

test('起動後に meta.json が消えると /api/state は 500 text/plain を返し、プロセスは応答を続ける', async (t) => {
  // Given: 有効な run を位置引数で開いたサーバー。この時点では /api/state が 200
  const sandbox = makeSandbox(t);
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-meta-removed'));
  const s = await startDashboard(t, sandbox, [runDir]);
  const before = await fetch(s.base + '/api/state');
  assert.equal(before.status, 200);
  await before.arrayBuffer();

  // When: 同じプロセスのまま meta.json を消してから /api/state を要求する
  rmSync(path.join(runDir, 'meta.json'));
  const res = await fetch(s.base + '/api/state');

  // Then: 500・text/plain。続く要求にも応答し、プロセスは終了していない
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  await res.arrayBuffer();
  const next = await fetch(s.base + '/');
  assert.equal(next.status, 200);
  assert.ok(isAlive(s.proc));
});

// ---------- 指摘 2: 起動時の run_dir 検証 ----------

test('存在しない run_dir を渡すと listen せずに exit 1 し、stderr に meta.json が読めない旨を出す', async (t) => {
  // Given: 存在しないディレクトリ
  const sandbox = makeSandbox(t);
  const missing = path.join(sandbox, 'no-such-run');

  // When: 位置引数に渡して起動する
  const r = await runUntilExit(t, sandbox, [missing]);

  // Then: 時間内に exit 1。stderr に meta.json が含まれ、起動メッセージ（listen 完了）は出ていない
  assert.equal(r.timedOut, false, '起動時に終了しなかった: ' + JSON.stringify(r));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /meta\.json/);
  assert.doesNotMatch(r.stdout, /http:\/\/localhost:/);
});

for (const [name, prepare] of [
  ['meta.json が無いディレクトリ', (dir) => mkdirSync(dir, { recursive: true })],
  ['meta.json が JSON として壊れているディレクトリ', (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'meta.json'), '{ broken'); }],
]) {
  test(`${name}を run_dir に渡すと listen せずに exit 1 する`, async (t) => {
    // Given: ディレクトリはあるが meta.json を読めない
    const sandbox = makeSandbox(t);
    const dir = path.join(sandbox, 'run-unreadable');
    prepare(dir);

    // When: 位置引数に渡して起動する
    const r = await runUntilExit(t, sandbox, [dir]);

    // Then: 時間内に exit 1。stderr に meta.json が含まれ、listen していない
    assert.equal(r.timedOut, false, '起動時に終了しなかった: ' + JSON.stringify(r));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /meta\.json/);
    assert.doesNotMatch(r.stdout, /http:\/\/localhost:/);
  });
}

// ---------- 変えない挙動 ----------

test('有効な run_dir を渡すと通常どおり起動し、/api/state がその run を返す', async (t) => {
  // Given: meta.json がある run
  const sandbox = makeSandbox(t);
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-valid'));

  // When: 位置引数に渡して起動し、/api/state を要求する
  const s = await startDashboard(t, sandbox, [runDir]);
  const res = await fetch(s.base + '/api/state');

  // Then: 200・JSON で、active.runDir が渡した run
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const body = await res.json();
  assert.equal(body.active.runDir, runDir);
});

test('?run= に一覧に無い run を渡しても meta.json があれば開く', async (t) => {
  // Given: run 探索の対象外（.takt/runs の外）にある run と、run_dir 指定なしで起動したサーバー
  const sandbox = makeSandbox(t);
  const outside = makeRun(path.join(sandbox, 'elsewhere', 'run-outside'));
  const s = await startDashboard(t, sandbox);

  // When: ?run= にその run を渡す
  const res = await fetch(s.base + '/api/state?run=' + encodeURIComponent(outside));

  // Then: 200 で、active.runDir がその run
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.active.runDir, outside);
});

test('/api/report にファイルを渡すと 200 text/plain でその内容を返す', async (t) => {
  // Given: reports/a.md がある run
  const sandbox = makeSandbox(t);
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-report-file'));
  writeFileSync(path.join(runDir, 'reports', 'a.md'), '# レポート\n本文\n');
  const s = await startDashboard(t, sandbox, [runDir]);

  // When: そのファイルを要求する
  const res = await fetch(s.base + '/api/report?p=a.md');

  // Then: 200・text/plain・ファイルの内容そのまま
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), '# レポート\n本文\n');
});

test('/ は 200 text/html で no-store を付けて返す', async (t) => {
  // Given: 有効な run を開いたサーバー
  const sandbox = makeSandbox(t);
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-html'));
  const s = await startDashboard(t, sandbox, [runDir]);

  // When: ページを要求する
  const res = await fetch(s.base + '/');

  // Then: 200・text/html・cache-control no-store
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await res.arrayBuffer();
});

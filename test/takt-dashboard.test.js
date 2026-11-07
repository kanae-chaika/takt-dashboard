// bin/takt-dashboard を子プロセスとして起動し、HTTP と終了コードで振る舞いを確かめる。
// 実行: node --test test/takt-dashboard.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, copyFileSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN, spawnDashboard, startDashboard as startChild, stopDashboard } from './helpers.js';

const STARTUP_TIMEOUT_MS = 5000;

// 実際の ~/.takt や ~/.config/takt-dashboard を読ませないよう、HOME と cwd を一時ディレクトリにする。
// 消すのはファイルの全テストの後。t.after は登録順に走るので、テストごとに消すとサーバー（cwd がこの中）を止める前に消すことになる（Windows では使用中の cwd を消せない）
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true }); });
function makeSandbox() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
  sandboxes.push(dir);
  return dir;
}

function makeRun(runDir, meta = { status: 'completed', runSlug: path.basename(runDir) }) {
  mkdirSync(path.join(runDir, 'reports'), { recursive: true });
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta));
  return runDir;
}

// PATH を空にして、手元にインストールされた takt 本体（taktPackageDir が PATH から探す）を読ませない
const ENV = { PATH: '', TAKT_DASHBOARD_ROOTS: '' };

// 起動メッセージが出るまで待つ。テストの終わりに止める
async function startDashboard(t, sandbox, extraArgs = []) {
  const d = await startChild({ cwd: sandbox, home: sandbox, args: extraArgs, env: ENV });
  t.after(() => stopDashboard(d));
  return d;
}

// 起動時に終了することを期待するケース。時間内に終わらなければ kill して「終了しなかった」と分かる結果を返す
async function runUntilExit(t, sandbox, extraArgs) {
  const d = spawnDashboard({ cwd: sandbox, home: sandbox, args: extraArgs, env: ENV });
  t.after(() => stopDashboard(d));
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), STARTUP_TIMEOUT_MS));
  const r = await Promise.race([d.exited, timeout]);
  if (r === 'timeout') { d.proc.kill('SIGKILL'); await d.exited; return { code: null, timedOut: true, ...d.out }; }
  return { code: r.code, timedOut: false, ...d.out };
}

const isAlive = (proc) => proc.exitCode === null && proc.signalCode === null;

// ---------- 指摘 1: /api/report にディレクトリを渡す ----------

test('/api/report にディレクトリを渡すと 404 not found を返し、プロセスは応答を続ける', async (t) => {
  // Given: reports/ 配下にサブディレクトリがある run を位置引数で開いたサーバー
  const sandbox = makeSandbox();
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
  const sandbox = makeSandbox();
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

test('bin/ui/ のファイルを読めないと / は 500 text/plain を返し、プロセスは応答を続ける', async (t) => {
  // Given: bin/takt-dashboard と bin/ui/ を一時ディレクトリへコピーし、コピーから app.css を消して起動したサーバー。
  // UI_DIR はスクリプトの場所（import.meta.url）基準なので、コピーを起動すればリポジトリの bin/ui/ は書き換えずに済む。
  // 拡張子の無いスクリプトを ESM として読ませるため、すぐ上に "type": "module" の package.json を置く（リポジトリと同じ構成）
  const sandbox = makeSandbox();
  const pkgBin = path.join(sandbox, 'pkg', 'bin');
  mkdirSync(pkgBin, { recursive: true });
  copyFileSync(BIN, path.join(pkgBin, 'takt-dashboard'));
  cpSync(path.join(path.dirname(BIN), 'ui'), path.join(pkgBin, 'ui'), { recursive: true });
  writeFileSync(path.join(sandbox, 'pkg', 'package.json'), JSON.stringify({ type: 'module' }));
  rmSync(path.join(pkgBin, 'ui', 'app.css'));
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-ui-missing'));
  const s = await startChild({ cwd: sandbox, home: sandbox, args: [runDir], env: ENV, bin: path.join(pkgBin, 'takt-dashboard') });
  t.after(() => stopDashboard(s));

  // When: ページを要求する
  const res = await fetch(s.base + '/');

  // Then: 接続を切らずに 500・text/plain・internal error。続く要求にも応答し、プロセスは終了していない
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'internal error');
  const next = await fetch(s.base + '/api/state');
  assert.equal(next.status, 200);
  await next.arrayBuffer();
  assert.ok(isAlive(s.proc));
});

// ---------- 指摘 2: 起動時の run_dir 検証 ----------

test('存在しない run_dir を渡すと listen せずに exit 1 し、stderr に meta.json が読めない旨を出す', async (t) => {
  // Given: 存在しないディレクトリ
  const sandbox = makeSandbox();
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
    const sandbox = makeSandbox();
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
  const sandbox = makeSandbox();
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
  const sandbox = makeSandbox();
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
  const sandbox = makeSandbox();
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

// reportText は p を reports/ 基準で解決し、reports/ の中に収まらないパスを弾く（run の外のファイルを読ませない）。
// 弾いた結果の 404 と「ファイルが無い」404 を区別するため、指すファイルはどれも実在させ、同じサーバーで reports/ の中のファイルは 200 になることも確かめる
async function startWithOutsideFiles(t) {
  const sandbox = makeSandbox();
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-report-escape'));
  writeFileSync(path.join(runDir, 'reports', 'a.md'), '# レポート\n');
  const s = await startDashboard(t, sandbox, [runDir]);
  return { sandbox, runDir, s };
}

test('/api/report に p=../meta.json を渡すと 404 not found になり、run の meta.json を返さない', async (t) => {
  // Given: reports/a.md と meta.json がある run を開いたサーバー
  const { s } = await startWithOutsideFiles(t);

  // When: reports/ の 1 つ上（run の直下）の meta.json を相対パスで要求する
  const res = await fetch(s.base + '/api/report?p=' + encodeURIComponent('../meta.json'));

  // Then: 404・not found（meta.json の中身ではない）。reports/ の中のファイルは同じサーバーで読める
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
  assert.equal((await fetch(s.base + '/api/report?p=a.md')).status, 200);
});

test('/api/report に run の外のファイルの絶対パスを渡すと 404 not found になり、その中身を返さない', async (t) => {
  // Given: run の外（sandbox の直下）に実在するファイル
  const { sandbox, s } = await startWithOutsideFiles(t);
  const secret = path.join(sandbox, 'secret.txt');
  writeFileSync(secret, '秘密\n');

  // When: その絶対パスを p に渡す
  const res = await fetch(s.base + '/api/report?p=' + encodeURIComponent(secret));

  // Then: 404・not found
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
  assert.equal((await fetch(s.base + '/api/report?p=a.md')).status, 200);
});

test('/api/report に reports と名前の先頭が同じ隣のディレクトリのファイルを渡しても 404 not found になる', async (t) => {
  // Given: run の直下に reports-other/b.md（reports/ の外だが、パスの文字列は reports で始まる）
  const { runDir, s } = await startWithOutsideFiles(t);
  mkdirSync(path.join(runDir, 'reports-other'));
  writeFileSync(path.join(runDir, 'reports-other', 'b.md'), '# 隣\n');

  // When: ../reports-other/b.md を要求する（区切り文字を見ずに前方一致だけで判定すると通ってしまう）
  const res = await fetch(s.base + '/api/report?p=' + encodeURIComponent('../reports-other/b.md'));

  // Then: 404・not found
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
});

test('/ は 200 text/html で no-store を付け、bin/ui の CSS と JS を 1 枚の HTML に埋め込んで返す', async (t) => {
  // Given: 有効な run を開いたサーバー
  const sandbox = makeSandbox();
  const runDir = makeRun(path.join(sandbox, '.takt', 'runs', 'run-html'));
  const s = await startDashboard(t, sandbox, [runDir]);

  // When: ページを要求する
  const res = await fetch(s.base + '/');

  // Then: 200・text/html・cache-control no-store。CSS / JS は別ファイルへの参照ではなく中身が入っている（ルートは / だけで済ませる）
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.doesNotMatch(html, /<link rel="stylesheet"|<script src=/);
  assert.match(html, /<style>\n[\s\S]+<\/style>/);
  assert.match(html, /<script>\n[\s\S]*function tick\(\)[\s\S]*<\/script>/);
});

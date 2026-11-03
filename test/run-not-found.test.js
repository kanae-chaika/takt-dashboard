// 実行: node --test test/run-not-found.test.js
// ?run= に見つからない run を指定したときのサーバ側の挙動（Issue #1 の指摘 10）。
// bin/takt-dashboard を子プロセスで起動し、HTTP の応答で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

// サーバは run ディレクトリを process.cwd()（実パス）から作るので、期待値も実パスにそろえる
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo');
const LATEST = path.join(REPO, '.takt', 'runs', '20261029-100000-latest');
const OLDER = path.join(REPO, '.takt', 'runs', '20261029-090000-older');
const OUTSIDE = path.join(ROOT, 'outside', '20261029-080000-zip'); // 一覧の探索先の外に置く（zip で持ってきた run 相当）
const MISSING = path.join(ROOT, 'missing-run'); // 作らない
const LATEST_REPORT = 'latest run の plan レポート\n';

function writeRun(runDir, slug, updatedAt) {
  fs.mkdirSync(runDir, { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'plan', startTime: updatedAt, updatedAt }));
}

const startServer = (fixedRun) => startDashboard({ cwd: REPO, home: HOME, args: fixedRun ? [fixedRun] : [] });
const stopServer = stopDashboard;

const getState = async (server, query = '') => (await fetch(server.base + '/api/state' + query)).json();
// ローカルの run を、同じ場所を指すネットワーク上のパスの形にする。Linux / macOS では //tmp/… は /tmp/… と同じ場所。
// Windows では、同じくローカルを指す \\?\C:\… の形にする（Windows の実機では未確認）
const asNetworkPath = (p) => (process.platform === 'win32' ? '\\\\?\\' + p : '/' + p);

let plain; // <run_dir> なしで起動
let fixed; // <run_dir> に OLDER を渡して起動
let fixedOutside; // <run_dir> に一覧の外の OUTSIDE を渡して起動

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  writeRun(LATEST, '20261029-100000-latest', '2026-10-29T10:00:00.000Z');
  fs.mkdirSync(path.join(LATEST, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(LATEST, 'reports', 'plan.md'), LATEST_REPORT);
  writeRun(OLDER, '20261029-090000-older', '2026-10-29T09:00:00.000Z');
  writeRun(OUTSIDE, '20261029-080000-zip', '2026-10-29T08:00:00.000Z');
  fs.mkdirSync(path.join(OUTSIDE, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE, 'reports', 'plan.md'), 'outside のレポート\n');
  plain = await startServer(null);
  fixed = await startServer(OLDER);
  fixedOutside = await startServer(OUTSIDE);
});

after(async () => {
  await stopServer(plain);
  await stopServer(fixed);
  await stopServer(fixedOutside);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('C-SRV-NOFALLBACK: 見つからない ?run= では最新の run を返さない', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(MISSING));
  assert.equal(body.active, null);
});

test('C-SRV-NOFALLBACK: <run_dir> で起動していても、見つからない ?run= では固定した run を返さない', async () => {
  const body = await getState(fixed, '?run=' + encodeURIComponent(MISSING));
  assert.equal(body.active, null);
});

test('C-SRV-FIELD: 見つからない ?run= の応答に runNotFound として指定値と run の一覧が入る', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(MISSING));
  assert.equal(body.runNotFound, MISSING);
  assert.ok(Array.isArray(body.runs));
  assert.deepEqual(body.runs.map((r) => r.runDir).sort(), [LATEST, OLDER].sort());
  assert.equal(body.runsTotal, 2);
});

test('C-SRV-REPORT: 見つからない ?run= では最新の run のレポートを返さない', async () => {
  // 対照: run を指定しなければ同じ p で最新の run のレポートが返る（p が実在することの確認）
  const ok = await fetch(plain.base + '/api/report?p=plan.md');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), LATEST_REPORT);
  const res = await fetch(plain.base + '/api/report?p=plan.md&run=' + encodeURIComponent(MISSING));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
});

test('K-NOSEL: ?run= なしでは最新の run を返し、runNotFound は付かない', async () => {
  const body = await getState(plain);
  assert.equal(body.active.runDir, LATEST);
  assert.equal('runNotFound' in body, false);
});

test('K-METAJSON: 一覧に無くても meta.json がある run は ?run= で開ける', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(OUTSIDE));
  assert.equal(body.active.runDir, OUTSIDE);
  assert.equal('runNotFound' in body, false);
});

test('K-FIXED: <run_dir> で起動したときは ?run= なしでその run を返す', async () => {
  const body = await getState(fixed);
  assert.equal(body.active.runDir, OLDER);
  assert.equal('runNotFound' in body, false);
});

// ?run= は外部サイトのリンクや埋め込みからも届く。一覧に無いネットワーク上のパス（Windows では SMB に接続して資格情報を送る）は、meta.json を読む前に見つからない扱いにする
test('K-NETPATH: 先頭が // のパスは、実在する run を指していても ?run= で開かず、レポートも返さない', async () => {
  // net は OUTSIDE と同じ場所を指すので、修正前は OUTSIDE が開けていた（ローカルの絶対パスで開けることは K-METAJSON で確かめている）
  const ok = await fetch(plain.base + '/api/report?p=plan.md&run=' + encodeURIComponent(OUTSIDE));
  assert.equal(ok.status, 200, 'ローカルの絶対パスならレポートが返る（前提）');
  const net = asNetworkPath(OUTSIDE);
  const body = await getState(plain, '?run=' + encodeURIComponent(net));
  assert.equal(body.active, null);
  assert.equal(body.runNotFound, net);
  const res = await fetch(plain.base + '/api/report?p=plan.md&run=' + encodeURIComponent(net));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
});

// UI は 2 回目の取得から、表示中の run の runDir を ?run= で送り返す。<run_dir> は一覧に入らないことがあるので、その runDir では開ける必要がある
// （Windows で <run_dir> が \\host\share\… のとき、ネットワーク上のパスの判定より前に照合しないと開けなくなる。Linux ではその形を作れないので、照合の経路だけを確かめる）
test('K-FIXED-RUNDIR: <run_dir> で起動したサーバーに、その runDir を ?run= で送ると、その run とレポートを返す', async () => {
  const body = await getState(fixedOutside, '?run=' + encodeURIComponent(OUTSIDE));
  assert.equal(body.active.runDir, OUTSIDE);
  assert.equal('runNotFound' in body, false);
  const res = await fetch(fixedOutside.base + '/api/report?p=plan.md&run=' + encodeURIComponent(OUTSIDE));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'outside のレポート\n');
});

test('K-NETPATH: <run_dir> で起動していても、その run をネットワーク上のパスの形で指定すると開かない', async () => {
  const net = asNetworkPath(OUTSIDE);
  const body = await getState(fixedOutside, '?run=' + encodeURIComponent(net));
  assert.equal(body.active, null);
  assert.equal(body.runNotFound, net);
});

test('K-NETPATH: <run_dir> で起動していても、別の run をネットワーク上のパスの形で指定すると開かず、レポートも返さない', async () => {
  const net = asNetworkPath(LATEST);
  const body = await getState(fixedOutside, '?run=' + encodeURIComponent(net));
  assert.equal(body.active, null);
  assert.equal(body.runNotFound, net);
  const res = await fetch(fixedOutside.base + '/api/report?p=plan.md&run=' + encodeURIComponent(net));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');
});

test('K-NETPATH: UNC の各形式（\\\\host\\share・//host/share・\\\\?\\UNC\\…・\\\\.\\pipe\\…・/\\host\\share）は見つからない扱いになる', async () => {
  for (const p of ['\\\\host\\share\\run', '//host/share/run', '\\\\?\\UNC\\host\\share\\run', '\\\\.\\pipe\\x', '/\\host\\share\\run']) {
    const body = await getState(plain, '?run=' + encodeURIComponent(p));
    assert.equal(body.active, null, p);
    assert.equal(body.runNotFound, p, p);
  }
});

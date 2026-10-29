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

let plain; // <run_dir> なしで起動
let fixed; // <run_dir> に OLDER を渡して起動

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  writeRun(LATEST, '20261029-100000-latest', '2026-10-29T10:00:00.000Z');
  fs.mkdirSync(path.join(LATEST, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(LATEST, 'reports', 'plan.md'), LATEST_REPORT);
  writeRun(OLDER, '20261029-090000-older', '2026-10-29T09:00:00.000Z');
  writeRun(OUTSIDE, '20261029-080000-zip', '2026-10-29T08:00:00.000Z');
  plain = await startServer(null);
  fixed = await startServer(OLDER);
});

after(async () => {
  await stopServer(plain);
  await stopServer(fixed);
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

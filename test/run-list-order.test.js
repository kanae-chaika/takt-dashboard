// 実行: node --test test/run-list-order.test.js
// run の一覧（プルダウン）の並び。一覧は新しい 20 件で、表示中の run がそれより古いときは末尾に足す
// （先頭に足すと、最新の run が 2 番目になり、一覧が新しい順に見えなくなる）。
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
const TOTAL = 25; // 一覧の上限（20 件）より多くする
// RUNS[0] が最新、RUNS[TOTAL - 1] が最古（1 時間ずつ古くなる）
const RUNS = Array.from({ length: TOTAL }, (_, i) => {
  const slug = 'run-' + String(i).padStart(2, '0');
  return { slug, runDir: path.join(REPO, '.takt', 'runs', slug), updatedAt: new Date(Date.UTC(2026, 9, 29, 23 - i)).toISOString() };
});
const LATEST = RUNS[0].runDir;
const IN_TOP = RUNS[5].runDir; // 新しい 20 件に入る
const OLD = RUNS[22].runDir; // 新しい 20 件に入らない
const OUTSIDE = path.join(ROOT, 'outside', 'run-zip'); // 一覧の探索先の外に置く（zip で持ってきた run 相当）
const TOP20 = RUNS.slice(0, 20).map((r) => r.runDir);

function writeRun(runDir, slug, updatedAt) {
  fs.mkdirSync(runDir, { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'plan', startTime: updatedAt, updatedAt }));
}

const getState = async (server, query = '') => (await fetch(server.base + '/api/state' + query)).json();
const dirs = (body) => body.runs.map((r) => r.runDir);

let plain; // <run_dir> なしで起動
let fixed; // <run_dir> に OLD を渡して起動

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  for (const r of RUNS) writeRun(r.runDir, r.slug, r.updatedAt);
  writeRun(OUTSIDE, 'run-zip', '2026-10-28T00:00:00.000Z');
  plain = await startDashboard({ cwd: REPO, home: HOME, args: [] });
  fixed = await startDashboard({ cwd: REPO, home: HOME, args: [OLD] });
});

after(async () => {
  await stopDashboard(plain);
  await stopDashboard(fixed);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('?run= なしでは、一覧は新しい 20 件を新しい順に返す', async () => {
  const body = await getState(plain);
  assert.equal(body.active.runDir, LATEST);
  assert.deepEqual(dirs(body), TOP20);
  assert.equal(body.runsTotal, TOTAL);
});

test('新しい 20 件に入る run を ?run= で指定しても、一覧の並びは変わらない', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(IN_TOP));
  assert.equal(body.active.runDir, IN_TOP);
  assert.deepEqual(dirs(body), TOP20);
});

test('新しい 20 件に入らない run を ?run= で指定すると、一覧の 1 番目は最新の run のままで、指定した run は末尾に足される', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(OLD));
  assert.equal(body.active.runDir, OLD);
  assert.equal(dirs(body)[0], LATEST);
  assert.deepEqual(dirs(body), [...TOP20, OLD]);
  assert.equal(body.runsTotal, TOTAL);
});

test('一覧の探索先の外にある run を ?run= で指定したときも、末尾に足される', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(OUTSIDE));
  assert.equal(body.active.runDir, OUTSIDE);
  assert.deepEqual(dirs(body), [...TOP20, OUTSIDE]);
});

test('<run_dir> に古い run を渡して起動したときも、その run は一覧の末尾に足される', async () => {
  const body = await getState(fixed);
  assert.equal(body.active.runDir, OLD);
  assert.deepEqual(dirs(body), [...TOP20, OLD]);
});

test('全件（all=1）では、古い run を指定しても足されず、新しい順のまま全件が返る', async () => {
  const body = await getState(plain, '?run=' + encodeURIComponent(OLD) + '&all=1');
  assert.equal(body.active.runDir, OLD);
  assert.deepEqual(dirs(body), RUNS.map((r) => r.runDir));
  assert.equal(body.runsTotal, TOTAL);
});

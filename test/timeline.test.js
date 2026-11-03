// 実行: node --test test/timeline.test.js
// /api/state の timeline の行の組み立てを確かめる。
// - 並列の子のリトライ: 同じ iteration のまま execute から走り直すと、2 回目以降を別の試行として key に @n を付ける
// - レポートの紐づけ: mtime が report フェーズの時間帯（無ければ step 全体の時間帯）に入る iteration の行に付ける
// HOME と cwd は一時ディレクトリにし、PATH を空にして手元の takt 本体を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-timeline-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo');
const RUNS = path.join(REPO, '.takt', 'runs');

const START = '2026-11-01T10:00:00.000Z';
const at = (sec) => new Date(Date.parse(START) + sec * 1000).toISOString();

// meta.json に workflow は入れない（並列の子の tag を workflow yaml から引く経路に入れないため）。status は completed（end 行を作らない）
function writeRun(slug, events, reportFiles = {}) {
  const runDir = path.join(RUNS, slug);
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, startTime: START, updatedAt: at(300) }));
  fs.writeFileSync(path.join(runDir, 'logs', 'run.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // reportFiles は { reports からの相対パス: mtime の秒（at に渡す値） }
  for (const [rel, sec] of Object.entries(reportFiles)) {
    const p = path.join(runDir, 'reports', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# ' + rel + '\n');
    const d = new Date(at(sec));
    fs.utimesSync(p, d, d);
  }
  return runDir;
}

// 並列の子 arch-review を 1 回目の execute が error になった後に同じ iteration で再実行し、flow-review は 1 回だけ実行した run
const RUN_RETRY = path.join(RUNS, '20261101-100000-retry');
const RETRY_EVENTS = [
  { type: 'step_start', step: 'reviewers', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(1) },
  { type: 'phase_start', step: 'arch-review', iteration: 1, phaseName: 'execute', timestamp: at(2) },
  { type: 'phase_complete', step: 'arch-review', iteration: 1, phaseName: 'execute', status: 'error', error: 'rate limited', timestamp: at(3) },
  { type: 'phase_start', step: 'flow-review', iteration: 1, phaseName: 'execute', timestamp: at(4) },
  { type: 'phase_start', step: 'arch-review', iteration: 1, phaseName: 'execute', timestamp: at(5) },
];

// step plan を 2 iteration 実行した run。iteration の時刻は 100 秒離す（紐づけの ±5 秒の窓が重ならないように）。
// withReport が true なら各 iteration に report フェーズを置く（手順 1）、false なら置かない（手順 2: step 全体の時間帯）
function planEvents(withReport) {
  const out = [];
  for (const [it, o] of [[1, 0], [2, 100]]) {
    out.push({ type: 'step_start', step: 'plan', iteration: it, provider: 'claude', model: 'sonnet', timestamp: at(o) });
    out.push({ type: 'phase_start', step: 'plan', iteration: it, phaseName: 'execute', timestamp: at(o + 1) });
    out.push({ type: 'phase_complete', step: 'plan', iteration: it, phaseName: 'execute', status: 'done', timestamp: at(o + 10) });
    if (withReport) {
      out.push({ type: 'phase_start', step: 'plan', iteration: it, phaseName: 'report', timestamp: at(o + 11) });
      out.push({ type: 'phase_complete', step: 'plan', iteration: it, phaseName: 'report', status: 'done', timestamp: at(o + 20) });
    }
    out.push({ type: 'step_complete', step: 'plan', iteration: it, status: 'done', timestamp: at(o + 21) });
  }
  return out;
}
// レポートのファイル名（stem）は step 名と同じ plan にする。時刻で引けずにファイル名一致（手順 3）に落ちると、
// 両方とも最後の plan の行（plan#2）に付くので、iteration 1 の分が plan#1 に付くかで区別できる
const ITER1 = path.join('iter1', 'plan.md'), ITER2 = path.join('iter2', 'plan.md');
const RUN_PHASE = path.join(RUNS, '20261101-100100-report-phase');
const RUN_WINDOW = path.join(RUNS, '20261101-100200-step-window');

let server;

before(async () => {
  fs.mkdirSync(path.join(HOME, '.takt'), { recursive: true });
  writeRun(path.basename(RUN_RETRY), RETRY_EVENTS);
  // report フェーズの終了（o + 20）の直前に書かれたレポート
  writeRun(path.basename(RUN_PHASE), planEvents(true), { [ITER1]: 19, [ITER2]: 119 });
  // report フェーズが無いので、step 全体（o 〜 o + 21）の中の時刻にする
  writeRun(path.basename(RUN_WINDOW), planEvents(false), { [ITER1]: 15, [ITER2]: 115 });
  server = await startDashboard({ cwd: REPO, home: HOME, env: { PATH: '', TAKT_DASHBOARD_ROOTS: '' } });
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function getTimeline(runDir) {
  const res = await fetch(server.base + '/api/state?run=' + encodeURIComponent(runDir));
  assert.equal(res.status, 200);
  return (await res.json()).timeline;
}
const reportsOf = (timeline, key) => {
  const row = timeline.find((r) => r.kind === 'step' && r.key === key);
  assert.ok(row, key + ' の行がある');
  return row.reports;
};

// ---------- 並列の子のリトライ（@n） ----------

test('同じ iteration の並列の子を再実行すると、key が x#1 と x#1@2 の 2 行に分かれる', async () => {
  const timeline = await getTimeline(RUN_RETRY);
  const subKeys = (step) => timeline.filter((r) => r.kind === 'sub' && r.step === step).map((r) => r.key);
  // 再実行した arch-review は 2 行。1 回しか実行していない flow-review には @n を付けない
  assert.deepEqual(subKeys('arch-review'), ['arch-review#1', 'arch-review#1@2']);
  assert.deepEqual(subKeys('flow-review'), ['flow-review#1']);
});

// ---------- レポートの紐づけ（mtime） ----------

test('同じ step を 2 iteration 実行した run で、レポートは mtime が入る report フェーズの iteration の行に付く', async () => {
  const timeline = await getTimeline(RUN_PHASE);
  assert.deepEqual(reportsOf(timeline, 'plan#1'), [ITER1]);
  assert.deepEqual(reportsOf(timeline, 'plan#2'), [ITER2]);
});

test('report フェーズのイベントが無い run でも、レポートは mtime が入る step 全体の時間帯の iteration の行に付く', async () => {
  const timeline = await getTimeline(RUN_WINDOW);
  assert.deepEqual(reportsOf(timeline, 'plan#1'), [ITER1]);
  assert.deepEqual(reportsOf(timeline, 'plan#2'), [ITER2]);
});

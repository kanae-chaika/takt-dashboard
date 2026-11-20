// 実行: node --test test/timeline.test.js
// /api/state の timeline の行の組み立てを確かめる。
// - 並列の子のリトライ: 同じ iteration のまま execute から走り直すと、2 回目以降を別の試行として key に @n を付ける
// - レポートの紐づけ: mtime が report フェーズの時間帯（無ければ step 全体の時間帯）に入る iteration の行に付ける
// - レポートを付ける行: 終了行（通常ステップは完了の行、並列の子は report フェーズの終了の行）。終了行が無ければ開始行
// - takt の内部用ディレクトリ（.takt-report-internal/。reports 直下にも subworkflows の中にもできる）の .md はレポートとして拾わない
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
// 両方とも最後の plan の完了の行（plan#2）に付くので、iteration 1 の分が plan#1 に付くかで区別できる
const ITER1 = path.join('iter1', 'plan.md'), ITER2 = path.join('iter2', 'plan.md');
const RUN_PHASE = path.join(RUNS, '20261101-100100-report-phase');
const RUN_WINDOW = path.join(RUNS, '20261101-100200-step-window');
// RUN_PHASE はどちらの手順でも同じ行になるので、手順 1（report フェーズ）が手順 2 より先に効くことはこの run で確かめる。
// iteration 1 は report フェーズ（11 〜 20）で終わり、直後に iteration 2 が report フェーズなしで短く走る（21 〜 24）。
// mtime 23 は iteration 1 の report フェーズの終了 + 5 秒の窓に入る（手順 1 なら plan#1）。
// step 全体の時間帯では両方の窓に入り、終了時刻は iteration 2（24）の方が近い（手順 2 だけなら plan#2）
const RUN_PHASE_FIRST = path.join(RUNS, '20261101-100300-report-phase-first');
const PHASE_FIRST_EVENTS = [
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(0) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', timestamp: at(1) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'execute', status: 'done', timestamp: at(10) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'report', timestamp: at(11) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'report', status: 'done', timestamp: at(20) },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', timestamp: at(20) },
  { type: 'step_start', step: 'plan', iteration: 2, provider: 'claude', model: 'sonnet', timestamp: at(21) },
  { type: 'phase_start', step: 'plan', iteration: 2, phaseName: 'execute', timestamp: at(22) },
  { type: 'phase_complete', step: 'plan', iteration: 2, phaseName: 'execute', status: 'done', timestamp: at(23) },
  { type: 'step_complete', step: 'plan', iteration: 2, status: 'done', timestamp: at(24) },
];

// takt 0.74.0 は reports/.takt-report-internal/executions/versions/<uuid>/ にレポートの版ごとのコピーを、元のレポートと同じ時刻に書く。
// 元のレポートとコピーを同じ mtime（plan#1 の report フェーズの中の 19 秒）で、reports 直下と subworkflows の中の両方に置く。
// 時間帯の外（250 秒）には、内部ファイル（team-leader/audit/a.md）と、比較用の通常のレポート（other.md）を置く。
// どちらも stem が step 名と違うので、ファイル名一致（手順 3）でも行に付かず、未分類（active.reports）に入るかで区別できる
const RUN_INTERNAL = path.join(RUNS, '20261101-100400-report-internal');
const UUID = '0b6f3c1e-8a52-4d1b-9e07-3f2a6c4d5e81';
const INTERNAL = '.takt-report-internal';
const SUB_PLAN = path.join('subworkflows', 'x', 'plan.md');
const INTERNAL_FILES = {
  [path.join(INTERNAL, 'executions', 'versions', UUID, 'plan.md')]: 19,
  [path.join('subworkflows', 'x', INTERNAL, 'executions', 'versions', UUID, 'plan.md')]: 19,
  [path.join(INTERNAL, 'team-leader', 'audit', 'a.md')]: 250,
};

// 通常ステップ plan（完了）→ 並列の子 arch-review（judge まで完了）→ 通常ステップ fix（report フェーズまで終わり、step_complete がまだ無い）の run。
// step_complete の timestamp は実際のログと同じく execute の終了時刻にする（report フェーズより前）
const RUN_END_ROW = path.join(RUNS, '20261101-100500-end-row');
const SUB_REPORT = path.join('subworkflows', 'x', 'arch-review.md');
const END_ROW_EVENTS = [
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(0) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', timestamp: at(1) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'execute', status: 'done', timestamp: at(10) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'report', timestamp: at(11) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'report', status: 'done', timestamp: at(20) },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', timestamp: at(10) },
  { type: 'step_start', step: 'reviewers', iteration: 2, provider: 'claude', model: 'sonnet', timestamp: at(100) },
  { type: 'phase_start', step: 'arch-review', iteration: 2, phaseName: 'execute', timestamp: at(101) },
  { type: 'phase_complete', step: 'arch-review', iteration: 2, phaseName: 'execute', status: 'done', timestamp: at(110) },
  { type: 'phase_start', step: 'arch-review', iteration: 2, phaseName: 'report', timestamp: at(111) },
  { type: 'phase_complete', step: 'arch-review', iteration: 2, phaseName: 'report', status: 'done', timestamp: at(120) },
  { type: 'phase_start', step: 'arch-review', iteration: 2, phaseName: 'judge', timestamp: at(121) },
  { type: 'phase_complete', step: 'arch-review', iteration: 2, phaseName: 'judge', status: 'done', timestamp: at(125) },
  { type: 'step_complete', step: 'reviewers', iteration: 2, status: 'done', timestamp: at(125) },
  { type: 'step_start', step: 'fix', iteration: 3, provider: 'claude', model: 'sonnet', timestamp: at(200) },
  { type: 'phase_start', step: 'fix', iteration: 3, phaseName: 'execute', timestamp: at(201) },
  { type: 'phase_complete', step: 'fix', iteration: 3, phaseName: 'execute', status: 'done', timestamp: at(210) },
  { type: 'phase_start', step: 'fix', iteration: 3, phaseName: 'report', timestamp: at(211) },
  { type: 'phase_complete', step: 'fix', iteration: 3, phaseName: 'report', status: 'done', timestamp: at(220) },
];

// 通常ステップ plan がレート上限で中断し、同じ iteration のままリトライして完了した run。同じ key（plan#1）に開始行と完了の行が 2 つずつできる。
// レポートを書くのはリトライの report フェーズ（61 〜 70）
const RUN_RETRY_STEP = path.join(RUNS, '20261101-100600-retry-step');
const RETRY_STEP_EVENTS = [
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(0) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', timestamp: at(1) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'execute', status: 'rate_limited', timestamp: at(10) },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'rate_limited', timestamp: at(10) },
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(50) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', timestamp: at(51) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'execute', status: 'done', timestamp: at(60) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'report', timestamp: at(61) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'report', status: 'done', timestamp: at(70) },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', timestamp: at(60) },
];

// planEvents(true) の run に、どの step の時間帯にも入らない mtime（250 秒）の plan.md を置く（run フォルダをコピーして mtime が変わった場合）
const RUN_STEM = path.join(RUNS, '20261101-100700-stem');

let server;

before(async () => {
  fs.mkdirSync(path.join(HOME, '.takt'), { recursive: true });
  writeRun(path.basename(RUN_RETRY), RETRY_EVENTS);
  // report フェーズの終了（o + 20）の直前に書かれたレポート
  writeRun(path.basename(RUN_PHASE), planEvents(true), { [ITER1]: 19, [ITER2]: 119 });
  // report フェーズが無いので、step 全体（o 〜 o + 21）の中の時刻にする
  writeRun(path.basename(RUN_WINDOW), planEvents(false), { [ITER1]: 15, [ITER2]: 115 });
  writeRun(path.basename(RUN_PHASE_FIRST), PHASE_FIRST_EVENTS, { [ITER1]: 23 });
  writeRun(path.basename(RUN_INTERNAL), planEvents(true), { 'plan.md': 19, [SUB_PLAN]: 19, 'other.md': 250, ...INTERNAL_FILES });
  writeRun(path.basename(RUN_END_ROW), END_ROW_EVENTS, { 'plan.md': 20, [SUB_REPORT]: 120, 'fix.md': 220 });
  writeRun(path.basename(RUN_RETRY_STEP), RETRY_STEP_EVENTS, { 'plan.md': 70 });
  writeRun(path.basename(RUN_STEM), planEvents(true), { 'plan.md': 250 });
  server = await startDashboard({ cwd: REPO, home: HOME, env: { PATH: '', TAKT_DASHBOARD_ROOTS: '' } });
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function getState(runDir) {
  const res = await fetch(server.base + '/api/state?run=' + encodeURIComponent(runDir));
  assert.equal(res.status, 200);
  return res.json();
}
async function getTimeline(runDir) {
  return (await getState(runDir)).timeline;
}
// 通常ステップの完了の行（kind: done）に付いたレポート。開始行（kind: step）には付いていないことも確かめる
const reportsOf = (timeline, key) => {
  const row = timeline.find((r) => r.kind === 'done' && r.key === key);
  assert.ok(row, key + ' の完了の行がある');
  assert.deepEqual(timeline.filter((r) => r.kind === 'step' && r.key === key).flatMap((r) => r.reports ?? []), [], key + ' の開始行にはレポートが付かない');
  return row.reports ?? [];
};
// kind と key が一致する行それぞれのレポート（行の並び順）
const reportsByRow = (timeline, kind, key) => timeline.filter((r) => r.kind === kind && r.key === key).map((r) => r.reports ?? []);

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

test('mtime が report フェーズの窓と別の iteration の step 全体の時間帯の両方に入るとき、レポートは report フェーズの iteration の行に付く', async () => {
  const timeline = await getTimeline(RUN_PHASE_FIRST);
  // step 全体の時間帯だけで選ぶと、終了時刻が近い plan#2 に付く
  assert.deepEqual(reportsOf(timeline, 'plan#1'), [ITER1]);
  assert.deepEqual(reportsOf(timeline, 'plan#2'), []);
});

test('report フェーズのイベントが無い run でも、レポートは mtime が入る step 全体の時間帯の iteration の行に付く', async () => {
  const timeline = await getTimeline(RUN_WINDOW);
  assert.deepEqual(reportsOf(timeline, 'plan#1'), [ITER1]);
  assert.deepEqual(reportsOf(timeline, 'plan#2'), [ITER2]);
});

// ---------- レポートを付ける行（終了行） ----------

test('通常ステップのレポートは完了の行に付き、開始行には付かない', async () => {
  // Given: plan の report フェーズの終了時刻に plan.md が書かれ、step_complete の timestamp が report フェーズより前の run
  const timeline = await getTimeline(RUN_END_ROW);
  // Then: 完了の行に付く（reportsOf が開始行に付いていないことも確かめる）
  assert.deepEqual(reportsOf(timeline, 'plan#1'), ['plan.md']);
});

test('並列の子のレポートは report フェーズの終了行に付き、開始行・execute / judge の終了行には付かない', async () => {
  const timeline = await getTimeline(RUN_END_ROW);
  const phases = timeline.filter((r) => r.kind === 'phase' && r.key === 'arch-review#2').map((r) => [r.phase, r.reports ?? []]);
  assert.deepEqual(phases, [['execute', []], ['report', [SUB_REPORT]], ['judge', []]]);
  assert.deepEqual(reportsByRow(timeline, 'sub', 'arch-review#2'), [[]]);
});

test('完了の行がまだ無いステップのレポートは開始行に付く', async () => {
  // Given: fix の report フェーズまで終わり、step_complete がまだ書かれていない run（judge の途中・中断）
  const timeline = await getTimeline(RUN_END_ROW);
  assert.deepEqual(reportsByRow(timeline, 'done', 'fix#3'), []);
  assert.deepEqual(reportsByRow(timeline, 'step', 'fix#3'), [['fix.md']]);
});

test('レート上限で中断してリトライしたステップのレポートは、リトライの完了の行に付く', async () => {
  const timeline = await getTimeline(RUN_RETRY_STEP);
  // 同じ key の完了の行は、中断（rate_limited）→ 完了（done）の順に 2 つ。開始行 2 つには付かない
  assert.deepEqual(timeline.filter((r) => r.kind === 'done' && r.key === 'plan#1').map((r) => [r.status, r.reports ?? []]), [['rate_limited', []], ['done', ['plan.md']]]);
  assert.deepEqual(reportsByRow(timeline, 'step', 'plan#1'), [[], []]);
});

test('mtime がどの step の時間帯にも入らないレポートは、ファイル名が step 名と同じ最後の完了の行に付く', async () => {
  const timeline = await getTimeline(RUN_STEM);
  assert.deepEqual(reportsOf(timeline, 'plan#1'), []);
  assert.deepEqual(reportsOf(timeline, 'plan#2'), ['plan.md']);
});

// ---------- takt の内部用ディレクトリ（.takt-report-internal/） ----------

test('.takt-report-internal/ の下のレポートのコピーは行に付かず、元のレポートのリンクだけが 1 つずつ付く', async () => {
  // Given: plan#1 の report フェーズの中の時刻に、plan.md と subworkflows/x/plan.md と、それぞれの .takt-report-internal/ の中のコピーを置いた run
  // When: /api/state でタイムラインを取る
  const timeline = await getTimeline(RUN_INTERNAL);
  // Then: plan#1 には元のレポート 2 つだけが付く（mtime が同じで順序は readdir 次第なので並べ替えて比べる）
  assert.deepEqual([...reportsOf(timeline, 'plan#1')].sort(), ['plan.md', SUB_PLAN].sort());
  // どの行にも .takt-report-internal の中のパスは付かない
  const rels = timeline.flatMap((r) => r.reports ?? []);
  assert.deepEqual(rels.filter((rel) => rel.split(path.sep).includes(INTERNAL)), []);
});

test('時間帯の外にある .takt-report-internal/ の下の .md は未分類のレポートにも出ず、通常のレポートは未分類に出る', async () => {
  // Given: どの step の時間帯にも入らない時刻に、.takt-report-internal/team-leader/audit/a.md と other.md を置いた run
  // When: /api/state を取る
  const state = await getState(RUN_INTERNAL);
  const rels = state.active.reports.map((r) => r.rel);
  // Then: 通常のレポートは未分類に出て、内部ファイルは出ない
  assert.ok(rels.includes('other.md'), 'other.md が未分類に出る: ' + JSON.stringify(rels));
  assert.deepEqual(rels.filter((rel) => rel.split(path.sep).includes(INTERNAL)), []);
});

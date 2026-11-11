// 実行: node --test test/provider-switch.test.js
// レート上限などで provider が切り替わったとき、takt が再開時の指示文（phase_start.userInstruction）に書く通知文から切替を読むこと。
// 通知文は takt 0.74.0 の fallback-notice テンプレートの日本語版・英語版（英語が takt の既定言語）。model が無いと takt は空文字を入れる。
// bin/takt-dashboard を子プロセスで起動し、/api/state の timeline の開始行（step / sub）で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo');

// takt 0.74.0 の builtins/{ja,en}/facets/instructions/_system/fallback-notice.md を、renderFallbackNotice と同じく値を埋めて作る（model が無ければ空文字）
function notice(lang, [pp, pm], [cp, cm]) {
  if (lang === 'ja') {
    return ['## 注意: このステップは fallback 実行です', '', '直前のステップ実行は外部要因（rate_limit）で中断され、新しいセッションで再実行されています。', '前回のセッションのコンテキストは本セッションには引き継がれていません。', '',
      '- 中断されたステップ: plan', '- 中断時の iteration: 1', '- 中断理由: rate limited',
      '- 切替前 provider/model: ' + pp + ' / ' + (pm ?? ''), '- 現在の provider/model: ' + cp + ' / ' + (cm ?? ''), '',
      'ファイルや成果物としてディスクに残っている前回の作業成果は参照可能ですが、チャット上の文脈は失われています。必要に応じて次の手順で文脈を補ってください。'].join('\n');
  }
  return ['## Notice: This Step Is A Fallback Execution', '', 'The previous step execution was interrupted by an external condition (rate_limit) and is being retried in a new session.', 'The previous session context is not carried into this session.', '',
    '- Interrupted step: plan', '- Original iteration: 1', '- Interruption reason: rate limited',
    '- Previous provider/model: ' + pp + ' / ' + (pm ?? ''), '- Current provider/model: ' + cp + ' / ' + (cm ?? ''), '',
    'Previous work that remains on disk as files or reports is available, but chat context is not. Rebuild context as needed:'].join('\n');
}

const at = (s) => '2026-10-29T01:00:' + String(s).padStart(2, '0') + '.000Z';
// 通常の step: step_start の後の phase_start(execute) に通知文がある
const stepEvents = (ui) => [
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'codex', model: 'gpt-5', timestamp: at(1) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', userInstruction: ui, timestamp: at(2) },
];
// 並列の子: 親（review）の step_start の後、子（arch-review）の phase_start(execute) に通知文がある。子の開始行はこの phase_start から作られる
const subEvents = (ui) => [
  { type: 'step_start', step: 'review', iteration: 1, provider: 'codex', model: 'gpt-5', timestamp: at(1) },
  { type: 'phase_start', step: 'arch-review', iteration: 1, phaseName: 'execute', userInstruction: ui, timestamp: at(2) },
];

// レート上限 → リトライ。takt 0.74.0 の mock provider で並列の子をレート上限にした run と同じ並び（親の step_start は同じ iteration で 2 回出る）。
// 前の試行の開始から 5 秒以内にリトライが始まる（子が全部すぐレート上限に当たった場合など）
const subRetryEvents = (ui) => [
  { type: 'step_start', step: 'review', iteration: 1, provider: 'codex', model: 'gpt-5', timestamp: at(1) },
  { type: 'phase_start', step: 'arch-review', iteration: 1, phaseName: 'execute', timestamp: at(2) },
  { type: 'phase_complete', step: 'arch-review', iteration: 1, phaseName: 'execute', status: 'rate_limited', timestamp: at(2) },
  { type: 'step_complete', step: 'review', iteration: 1, status: 'rate_limited', timestamp: at(3) },
  { type: 'step_start', step: 'review', iteration: 1, provider: 'codex', model: 'gpt-5', timestamp: at(4) },
  { type: 'phase_start', step: 'arch-review', iteration: 1, phaseName: 'execute', userInstruction: ui, timestamp: at(5) },
  { type: 'phase_complete', step: 'arch-review', iteration: 1, phaseName: 'execute', status: 'done', timestamp: at(5) },
  { type: 'step_complete', step: 'review', iteration: 1, status: 'done', timestamp: at(6) },
];
const stepRetryEvents = (ui) => [
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'codex', model: 'gpt-5', timestamp: at(1) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', timestamp: at(1) },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'execute', status: 'rate_limited', timestamp: at(2) },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'rate_limited', timestamp: at(2) },
  { type: 'step_start', step: 'plan', iteration: 1, provider: 'codex', model: 'gpt-5', timestamp: at(3) },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', userInstruction: ui, timestamp: at(3) },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', timestamp: at(4) },
];

const CASES = {};
let n = 0;
function addCase(name, events) {
  const slug = '20261029-0100' + String(n++).padStart(2, '0') + '-' + name;
  const runDir = path.join(REPO, '.takt', 'runs', slug);
  CASES[name] = runDir;
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'plan', startTime: at(0), updatedAt: at(9) }));
  fs.writeFileSync(path.join(runDir, 'logs', 'a.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

let server;

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  for (const lang of ['ja', 'en']) {
    addCase(lang + '-step', stepEvents(notice(lang, ['codex', 'gpt-5'], ['claude', 'sonnet'])));
    addCase(lang + '-sub', subEvents(notice(lang, ['codex', 'gpt-5'], ['claude', 'sonnet'])));
    addCase(lang + '-cur-empty', stepEvents(notice(lang, ['codex', 'gpt-5'], ['claude', null])));
    addCase(lang + '-prev-empty', stepEvents(notice(lang, ['claude', null], ['codex', 'gpt-5'])));
    addCase(lang + '-sub-retry', subRetryEvents(notice(lang, ['codex', 'gpt-5'], ['claude', 'sonnet'])));
    addCase(lang + '-step-retry', stepRetryEvents(notice(lang, ['codex', 'gpt-5'], ['claude', 'sonnet'])));
  }
  // PATH を空にして、手元にインストールされた takt 本体を読ませない
  server = await startDashboard({ cwd: REPO, home: HOME, env: { PATH: '' } });
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// 同じ step の開始行すべて（時刻順。リトライがあれば試行ごとに 1 行）
async function startRows(name, kind, step) {
  const body = await (await fetch(server.base + '/api/state?run=' + encodeURIComponent(CASES[name]))).json();
  assert.equal(body.active?.runDir, CASES[name], 'run を開けた（前提）');
  const rows = body.timeline.filter((r) => r.kind === kind && r.step === step);
  assert.ok(rows.length, kind + ' の行 ' + step + ': ' + JSON.stringify(body.timeline));
  assert.equal(body.timeline.some((r) => r.kind === 'switch'), false, '切替は開始行に載り、別の行にならない');
  return rows;
}
const startRow = async (name, kind, step) => (await startRows(name, kind, step))[0];
const pmOf = (r) => ({ switchFrom: r.switchFrom ?? null, provider: r.provider, model: r.model, source: r.source });

for (const [lang, label] of [['ja', '日本語'], ['en', '英語']]) {
  test(label + 'の通知文: 通常の step の開始行に切替前と切替後の provider / model が載る', async () => {
    assert.deepEqual(pmOf(await startRow(lang + '-step', 'step', 'plan')), { switchFrom: 'codex/gpt-5', provider: 'claude', model: 'sonnet', source: 'log' });
  });

  test(label + 'の通知文: 並列の子の開始行に切替前と切替後の provider / model が載る', async () => {
    assert.deepEqual(pmOf(await startRow(lang + '-sub', 'sub', 'arch-review')), { switchFrom: 'codex/gpt-5', provider: 'claude', model: 'sonnet', source: 'log' });
  });

  test(label + 'の通知文: 切替後の model が空でも切替を読み、model は null（次の行の本文を model にしない）', async () => {
    assert.deepEqual(pmOf(await startRow(lang + '-cur-empty', 'step', 'plan')), { switchFrom: 'codex/gpt-5', provider: 'claude', model: null, source: 'log' });
  });

  test(label + 'の通知文: 切替前の model が空なら、切替前は provider 名だけ（次の行頭の「-」を model にしない）', async () => {
    assert.deepEqual(pmOf(await startRow(lang + '-prev-empty', 'step', 'plan')), { switchFrom: 'claude', provider: 'codex', model: 'gpt-5', source: 'log' });
  });

  test(label + 'の通知文: 並列の子のリトライが 5 秒以内に始まっても、切替はリトライの開始行に載り、前の試行の行には載らない', async () => {
    const rows = await startRows(lang + '-sub-retry', 'sub', 'arch-review');
    assert.deepEqual(rows.map((r) => [r.key, r.switchFrom ?? null]), [['arch-review#1', null], ['arch-review#1@2', 'codex/gpt-5']]);
    assert.deepEqual(pmOf(rows[1]), { switchFrom: 'codex/gpt-5', provider: 'claude', model: 'sonnet', source: 'log' });
  });

  test(label + 'の通知文: 通常の step のリトライでも、切替はリトライの開始行に載り、前の試行の行には載らない', async () => {
    const rows = await startRows(lang + '-step-retry', 'step', 'plan');
    assert.deepEqual(rows.map((r) => r.switchFrom ?? null), [null, 'codex/gpt-5']);
    assert.deepEqual(pmOf(rows[0]), { switchFrom: null, provider: 'codex', model: 'gpt-5', source: 'log' });
    assert.deepEqual(pmOf(rows[1]), { switchFrom: 'codex/gpt-5', provider: 'claude', model: 'sonnet', source: 'log' });
  });
}

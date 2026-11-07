// 実行: node --test test/provider-forms.test.js
// 並列の子の provider / model を、runtime.yaml のいろいろな書き方と takt の usage_events のログから引く経路を確かめる。
// - takt が自動生成する runtime.yaml はブロック形式（profiles の下が複数行）。手書きのフロー形式（{ provider: x }）と同じに読む
// - profile の extends は親の provider / model を子の値で上書きする（takt 0.74.0 の dist/infra/config/runtime-provider/policy.js）
// - ladder・pool・assignments・personas は設定から決まらないので provider / model を null（画面は「?」）にし、claude と断定しない
// - logs/*-usage-events.jsonl（takt の logging.usage_events）があれば、設定より優先して実際の値を出す
// ~/.takt の中身がケースごとに違うので、ケースごとに HOME とサーバーを分ける（HOME はサーバーの起動時に決まる）。
// PATH を空にして手元の takt 本体を読ませない
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

const START = '2026-11-01T10:00:00.000Z';
const at = (sec) => new Date(Date.parse(START) + sec * 1000).toISOString();

// HOME と repo を一時ディレクトリに作り、ファイルの全テストの後に消す（t.after は登録順に走るので、テストごとに消すとサーバーを止める前に消すことになる）
const sandboxes = [];
after(() => { for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true }); });
function makeSandbox(runtimeYaml) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-pm-')));
  sandboxes.push(root);
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.takt'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.takt', 'runs'), { recursive: true });
  if (runtimeYaml !== undefined) fs.writeFileSync(path.join(home, '.takt', 'runtime.yaml'), runtimeYaml);
  return { home, repo };
}

// 親 reviewers の下で並列の子 subs を実行した run。subs は [step 名, 開始の秒] の配列（同じ step を 2 回並べるとリトライ）。
// usage は usage-events.jsonl に書く記録（[step, provider, provider_model, 秒]）
function writeRun(repo, slug, subs, usage = [], workflow) {
  const runDir = path.join(repo, '.takt', 'runs', slug);
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'reviewers', startTime: START, updatedAt: at(300) }));
  const events = [{ type: 'step_start', step: 'reviewers', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(1) }];
  for (const [step, sec] of subs) events.push({ type: 'phase_start', step, iteration: 1, phaseName: 'execute', timestamp: at(sec), ...(workflow ? { workflow } : {}) });
  fs.writeFileSync(path.join(runDir, 'logs', 'session-1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (usage.length) {
    const lines = usage.map(([step, provider, model, sec]) => JSON.stringify({ run_id: slug, session_id: 'session-1', provider, provider_model: model, step, step_type: 'parallel', timestamp: at(sec), success: true, usage_missing: true, reason: 'not_available', usage: {} }));
    fs.writeFileSync(path.join(runDir, 'logs', 'session-1-usage-events.jsonl'), lines.join('\n') + '\n');
  }
  return runDir;
}

async function start(t, box) {
  const s = await startDashboard({ cwd: box.repo, home: box.home, env: { PATH: '', TAKT_DASHBOARD_ROOTS: '' } });
  t.after(() => stopDashboard(s));
  return s;
}

// 並列の子の行（同じ step が複数あれば開始順）の provider / model / source
async function subRows(s, runDir, step) {
  const res = await fetch(s.base + '/api/state?run=' + encodeURIComponent(runDir));
  assert.equal(res.status, 200);
  const rows = (await res.json()).timeline.filter((r) => r.kind === 'sub' && r.step === step);
  assert.ok(rows.length, step + ' の並列の子の行がある');
  return rows.map((r) => ({ provider: r.provider, model: r.model, source: r.source }));
}

// ---------- 書き方: ブロック形式・extends ----------

test('takt が生成するブロック形式の runtime.yaml（profiles の下が複数行）でも、並列の子は defaults の profile の provider / model になる', async (t) => {
  // Given: yaml ライブラリの stringify と同じブロック形式。defaults の profile は codex / gpt-5
  const box = makeSandbox(`version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: codex
      model: gpt-5
`);
  const runDir = writeRun(box.repo, '20261101-100000-block', [['arch-review', 2]]);
  const s = await start(t, box);

  // When / Then: 既定の claude・model なしではなく、profile の値
  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' }]);
});

test('ブロック形式の targets.steps の名指しは defaults より優先され、extends の profile は親の provider と自分の model になる', async (t) => {
  // Given: deep は base を extends して model だけ変える。arch-review だけ deep を名指し
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base:
      provider: claude
      model: sonnet
    deep:
      extends: base
      model: opus
  targets:
    steps:
      arch-review:
        profile: deep
`);
  const runDir = writeRun(box.repo, '20261101-100000-extends', [['arch-review', 2], ['flow-review', 3]]);
  const s = await start(t, box);

  // When / Then: 名指しの子は deep（provider は base から、model は自分の opus）。それ以外は defaults の base
  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'claude', model: 'opus', source: 'runtime.yaml' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: 'claude', model: 'sonnet', source: 'runtime.yaml' }]);
});

test('targets.steps の <workflow>/<step> のキーは <step> だけのキーより優先され、別の workflow のキーは使わない', async (t) => {
  // Given: 子のイベントの workflow は review。arch-review には review/arch-review と arch-review の両方、flow-review には other/flow-review だけがある
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: claude, model: sonnet }
    rev: { provider: codex, model: gpt-5 }
    plain: { provider: opencode, model: big }
  targets:
    steps:
      review/arch-review: { profile: rev }
      arch-review: { profile: plain }
      other/flow-review: { profile: rev }
`);
  const runDir = writeRun(box.repo, '20261101-100000-qualified', [['arch-review', 2], ['flow-review', 3]], [], 'review');
  const s = await start(t, box);

  // When / Then: takt と同じく review/arch-review が先。flow-review は workflow が違うので名指しなし扱いで defaults
  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: 'claude', model: 'sonnet', source: 'runtime.yaml' }]);
});

// ---------- 設定から決まらない書き方 ----------

test('defaults が ladder のときは、並列の子の provider / model を claude と断定せず null（画面は「?」）にする', async (t) => {
  // Given: ladder は昇格で次の profile に進むので、どれを使ったかは設定から決まらない
  const box = makeSandbox(`provider:
  defaults:
    ladder: [fast, deep]
  profiles:
    fast: { provider: codex, model: gpt-5 }
    deep: { provider: claude, model: opus }
`);
  const runDir = writeRun(box.repo, '20261101-100000-ladder', [['arch-review', 2]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: null, model: null, source: 'runtime.yaml' }]);
});

test('targets.steps が pool の step だけ null になり、他の step は defaults の profile のまま', async (t) => {
  // Given: arch-review は pool（実行時に router が選ぶ）、flow-review は名指しなし
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: claude, model: sonnet }
  targets:
    steps:
      arch-review:
        pool: reviewers
`);
  const runDir = writeRun(box.repo, '20261101-100000-pool', [['arch-review', 2], ['flow-review', 3]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: null, model: null, source: 'runtime.yaml' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: 'claude', model: 'sonnet', source: 'runtime.yaml' }]);
});

test('assignments（名前付きの割り当て）があるときは、どれが使われたか分からないので並列の子はすべて null', async (t) => {
  // Given: defaults.assignment で night を選ぶ設定。実行時の指定で別の割り当てになることもある
  const box = makeSandbox(`provider:
  defaults:
    assignment: night
  profiles:
    base: { provider: claude, model: sonnet }
    cheap: { provider: codex, model: gpt-5-mini }
  assignments:
    night:
      defaults:
        profile: cheap
  targets:
    steps:
      arch-review: { profile: base }
`);
  const runDir = writeRun(box.repo, '20261101-100000-assignments', [['arch-review', 2], ['flow-review', 3]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: null, model: null, source: 'runtime.yaml' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: null, model: null, source: 'runtime.yaml' }]);
});

test('targets.personas があるときは、steps で名指しした step はその profile、名指しの無い step は null', async (t) => {
  // Given: persona で引く割り当てがある（step の persona は読んでいないので、名指しの無い step は決められない）
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: claude, model: sonnet }
    rev: { provider: codex, model: gpt-5 }
  targets:
    steps:
      arch-review: { profile: rev }
    personas:
      reviewer: { profile: rev }
`);
  const runDir = writeRun(box.repo, '20261101-100000-personas', [['arch-review', 2], ['flow-review', 3]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: null, model: null, source: 'runtime.yaml' }]);
});

// ---------- usage_events のログ ----------

test('usage_events のログがあれば、並列の子は設定ではなくログの provider / model になり、(default) は model なしにする', async (t) => {
  // Given: 設定は codex / gpt-5 だが、ログには arch-review が claude / opus、flow-review が opencode / (default) で実行されたと書かれている
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: codex, model: gpt-5 }
`);
  const runDir = writeRun(box.repo, '20261101-100000-usage', [['arch-review', 2], ['flow-review', 3]],
    [['arch-review', 'claude', 'opus', 20], ['flow-review', 'opencode', '(default)', 25]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'claude', model: 'opus', source: 'log' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: 'opencode', model: null, source: 'log' }]);
});

test('同じ iteration で再実行した並列の子は、試行ごとに、その開始から次の試行の開始までのログの記録が当たる', async (t) => {
  // Given: arch-review を 2 回実行（2 回目が @2 の行）。ログには 1 回目が codex、2 回目が claude で記録されている
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: opencode, model: big }
`);
  const runDir = writeRun(box.repo, '20261101-100000-usage-retry', [['arch-review', 2], ['arch-review', 30]],
    [['arch-review', 'codex', 'gpt-5', 10], ['arch-review', 'claude', 'sonnet', 40]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [
    { provider: 'codex', model: 'gpt-5', source: 'log' },
    { provider: 'claude', model: 'sonnet', source: 'log' },
  ]);
});

test('記録の無い試行には、次の試行の記録を当てず設定の値のままにする', async (t) => {
  // Given: arch-review を 2 回実行。1 回目は記録が無く（途中で落ちた）、2 回目の後にだけ記録がある
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: opencode, model: big }
`);
  const runDir = writeRun(box.repo, '20261101-100000-usage-missing', [['arch-review', 2], ['arch-review', 30]],
    [['arch-review', 'claude', 'sonnet', 40]]);
  const s = await start(t, box);

  // When / Then: 1 回目は設定（opencode / big）、2 回目はログ（claude / sonnet）
  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [
    { provider: 'opencode', model: 'big', source: 'runtime.yaml' },
    { provider: 'claude', model: 'sonnet', source: 'log' },
  ]);
});

test('1 回の試行に記録が複数あるときは、その試行の区間の最後の記録を使う', async (t) => {
  // Given: arch-review の 1 回の実行中に、失敗の記録（codex）の後で完了の記録（claude）が書かれた
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: opencode, model: big }
`);
  const runDir = writeRun(box.repo, '20261101-100000-usage-multi', [['arch-review', 2]],
    [['arch-review', 'codex', 'gpt-5', 10], ['arch-review', 'claude', 'opus', 20]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'claude', model: 'opus', source: 'log' }]);
});

test('ログの記録がまだ無い並列の子（実行中）は、設定から引いた値のまま', async (t) => {
  // Given: arch-review は終わってログに記録がある。flow-review はまだ記録が無い
  const box = makeSandbox(`provider:
  defaults:
    profile: base
  profiles:
    base: { provider: codex, model: gpt-5 }
`);
  const runDir = writeRun(box.repo, '20261101-100000-usage-partial', [['arch-review', 2], ['flow-review', 3]],
    [['arch-review', 'claude', 'opus', 20]]);
  const s = await start(t, box);

  assert.deepEqual(await subRows(s, runDir, 'arch-review'), [{ provider: 'claude', model: 'opus', source: 'log' }]);
  assert.deepEqual(await subRows(s, runDir, 'flow-review'), [{ provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' }]);
});

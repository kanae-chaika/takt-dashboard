// 実行: node --test test/tag-routing.test.js
// 並列の子の provider / model を runtime.yaml の targets.tags からも引く（Issue #1 の指摘 18）。
// 優先順位は takt 本体（dist/core/workflow/provider-resolution.js）に揃える: targets.steps → targets.tags → defaults。
// step の tag は workflow yaml の step 定義の tags: から取る。
// bin/takt-dashboard を子プロセスで起動し、/api/state の timeline にある並列の子の行（kind: 'sub'）で確認する。
// HOME と cwd は一時ディレクトリにし、PATH を空にして手元の takt 本体の builtins を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-tags-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo');
const RUNS = path.join(REPO, '.takt', 'runs');
const HOME_WF = path.join(HOME, '.takt', 'workflows');
const REPO_WF = path.join(REPO, '.takt', 'workflows');
const SNAP_DIR = path.join(HOME, '.config', 'takt-dashboard', 'routing');

// 既存のパーサー（loadRuntimeRouting）が読める形: profiles は 4 字下げ、targets の steps / tags の下は 6 字下げ
const RUNTIME_YAML = `provider:
  defaults:
    profile: base
  profiles:
    base: { provider: claude, model: sonnet }
    rev: { provider: codex, model: gpt-5 }
    pin: { provider: claude, model: opus }
    code: { provider: opencode, model: big }
  targets:
    steps:
      pinned-review: { profile: pin }
    tags:
      review: { profile: rev }
      coding: { profile: code }
`;

// takt の builtins（review-takt-default.yaml）と同じ構成: all_steps は rules の設定、並列の子は parallel: → fixed: の下、
// tags: はブロック形式（- review）とフロー形式（[review]）の両方
const TAGWF_YAML = `name: tagwf
all_steps:
  rules:
    - ref: findings-handling
      position: before_instruction
max_steps: 30
initial_step: reviewers

steps:
  - name: reviewers
    description: 並列レビュー（親の step 自身には tags が無い）
    parallel:
      fixed:
        - name: arch-review
          capabilities: readonly
          tags:
            - review
          edit: false
        - name: flow-review
          tags: [review] # フロー形式
        - name: pinned-review
          tags: [review]
        - name: untagged-review
          edit: false
        - name: unknown-tag-review
          tags: [nosuch]
        - name: multi-review
          tags: [nosuch, review]
        - tags: [coding] # name: が最初のキーでない（YAML のキー順に意味は無い）
          name: late-name-review
        - description: 説明が先
          name: desc-first-review
          tags:
            - review
        -   name: wide-dash-review # - の後の空白が複数（キーの位置がずれる）
            tags: [review]
        - name: multiline-flow-review
          tags: [nosuch,
                 coding] # 複数行にまたがるフロー形式
    rules:
      - condition: all("approved")
        next: fix

  - name: fix
    tags:
      - coding
`;

// 一度表示した後に yaml を書き換える run 用（ほかの run の表示に影響しないよう別のワークフローにする）
const KEEPWF_YAML = `name: keepwf
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: arch-review
          tags:
            - review
`;

// 探索順の確認用: <root>/.takt/workflows/ に max_steps の無い yaml、~/.takt/workflows/ に max_steps のある yaml を置く
const PRJWF_REPO_YAML = `name: prjwf
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: arch-review
          tags: [review]
`;
const PRJWF_HOME_YAML = `name: prjwf
max_steps: 7
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: arch-review
          tags: [coding]
`;

const START = '2026-11-01T10:00:00.000Z';
const at = (sec) => new Date(Date.parse(START) + sec * 1000).toISOString();

// 並列の子の行は「step_start の無い step の phase_start(execute)」から作られる。
// subs は [step, workflow | undefined] の組（workflow が undefined ならイベントに workflow を書かない）
function writeRun(slug, { workflow, parentWorkflow = workflow, parentStep = 'reviewers', subs }) {
  const runDir = path.join(RUNS, slug);
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, workflow, currentStep: 'reviewers', startTime: START, updatedAt: at(60) }));
  const events = [{ type: 'step_start', step: parentStep, workflow: parentWorkflow, iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(1) }];
  subs.forEach(([step, wf], i) => {
    const e = { type: 'phase_start', step, iteration: 1, phaseName: 'execute', timestamp: at(2 + i) };
    if (wf !== undefined) e.workflow = wf;
    events.push(e);
  });
  fs.writeFileSync(path.join(runDir, 'logs', 'run.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// run の定義。before() で writeRun に渡して作る
const RUN_DEFS = {
  tag: ['20261101-100000-tag', { workflow: 'tagwf', subs: [['arch-review', 'tagwf'], ['flow-review', undefined], ['pinned-review', 'tagwf'], ['untagged-review', 'tagwf'], ['unknown-tag-review', 'tagwf'], ['multi-review', 'tagwf'], ['late-name-review', 'tagwf'], ['desc-first-review', 'tagwf'], ['wide-dash-review', 'tagwf'], ['multiline-flow-review', 'tagwf']] }],
  // reviewers 自身を並列の子の行として出すため、親の step_start は別の名前にする
  parent: ['20261101-100600-parent', { workflow: 'tagwf', parentStep: 'outer', subs: [['reviewers', 'tagwf']] }],
  // 子のワークフロー（e.workflow）が run のワークフロー（meta.workflow）と違う run。子の行は e.workflow の yaml から引く
  childwf: ['20261101-100100-childwf', { workflow: 'missingwf', parentWorkflow: 'tagwf', subs: [['arch-review', 'tagwf']] }],
  missing: ['20261101-100200-missing', { workflow: 'missingwf', subs: [['arch-review', 'missingwf'], ['flow-review', undefined]] }],
  oldsnap: ['20261101-100300-oldsnap', { workflow: 'tagwf', subs: [['arch-review', 'tagwf']] }],
  keep: ['20261101-100400-keep', { workflow: 'keepwf', subs: [['arch-review', 'keepwf']] }],
  prj: ['20261101-100500-prj', { workflow: 'prjwf', subs: [['arch-review', 'prjwf']] }],
};
const runPath = (k) => path.join(RUNS, RUN_DEFS[k][0]);
const RUN_TAG = runPath('tag'), RUN_CHILDWF = runPath('childwf'), RUN_MISSING = runPath('missing'), RUN_OLDSNAP = runPath('oldsnap'), RUN_KEEP = runPath('keep'), RUN_PRJ = runPath('prj'), RUN_PARENT = runPath('parent');

let server;

before(async () => {
  fs.mkdirSync(HOME_WF, { recursive: true });
  fs.mkdirSync(REPO_WF, { recursive: true });
  fs.writeFileSync(path.join(HOME, '.takt', 'runtime.yaml'), RUNTIME_YAML);
  fs.writeFileSync(path.join(HOME_WF, 'tagwf.yaml'), TAGWF_YAML);
  fs.writeFileSync(path.join(HOME_WF, 'keepwf.yaml'), KEEPWF_YAML);
  fs.writeFileSync(path.join(REPO_WF, 'prjwf.yaml'), PRJWF_REPO_YAML);
  fs.writeFileSync(path.join(HOME_WF, 'prjwf.yaml'), PRJWF_HOME_YAML);
  for (const [slug, opts] of Object.values(RUN_DEFS)) writeRun(slug, opts);
  // tags キーの無い古い控え（tags 対応前のダッシュボードが loadConfigRouting から保存したもの）
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(path.join(SNAP_DIR, path.basename(RUN_OLDSNAP) + '.json'), JSON.stringify({ steps: {}, def: { provider: 'claude', model: null }, source: 'config', mtime: 0 }));
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
// 並列の子の行の provider / model / source
async function subPm(runDir, step) {
  const body = await getState(runDir);
  const row = body.timeline.find((r) => r.kind === 'sub' && r.step === step);
  assert.ok(row, step + ' の並列の子の行がある');
  return { provider: row.provider, model: row.model, source: row.source };
}

test('targets.steps に名指しが無く、ブロック形式の tags: の tag が targets.tags にある並列の子は tag の profile になる', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'arch-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('フロー形式の tags: [review] でも tag の profile になる（イベントに workflow が無いときは run の workflow の yaml を使う）', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'flow-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('子のワークフロー（イベントの workflow）があれば、run の workflow ではなくそちらの yaml から tag を引く', async () => {
  // run の workflow（missingwf）の yaml は無い。子の workflow（tagwf）の yaml を使えば arch-review は review の tag になる
  assert.deepEqual(await subPm(RUN_CHILDWF, 'arch-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('targets.steps の名指しが targets.tags より優先される（takt 本体の優先順位: steps → tags）', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'pinned-review'), { provider: 'claude', model: 'opus', source: 'runtime.yaml' });
});

test('step に tags: が無いときは既定の profile になる', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'untagged-review'), { provider: 'claude', model: 'sonnet', source: 'runtime.yaml' });
});

test('step の tag が targets.tags に無いときは既定の profile になる', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'unknown-tag-review'), { provider: 'claude', model: 'sonnet', source: 'runtime.yaml' });
});

test('step の tag のうち targets.tags に無いものは飛ばし、あるものの profile を使う', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'multi-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('step の name: が最初のキーでなくても（tags: や description: が先でも）step と認識し、tag の profile を使う', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'late-name-review'), { provider: 'opencode', model: 'big', source: 'runtime.yaml' });
  assert.deepEqual(await subPm(RUN_TAG, 'desc-first-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('- の後の空白が複数ある要素（-   name:）も、キーの実際の位置で step と認識する', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'wide-dash-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('複数行にまたがるフロー形式の tags: [a,\\n b] は閉じ括弧まで読む', async () => {
  assert.deepEqual(await subPm(RUN_TAG, 'multiline-flow-review'), { provider: 'opencode', model: 'big', source: 'runtime.yaml' });
});

test('routing の控えは一時ファイルに書いてから置き換える（.tmp が残らず、控えは JSON として読めて stepTags を含む）', async () => {
  await subPm(RUN_TAG, 'arch-review');
  const names = fs.readdirSync(SNAP_DIR);
  assert.ok(!names.some((n) => n.endsWith('.tmp')), '.tmp が残っていない: ' + names.join(', '));
  const snap = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, path.basename(RUN_TAG) + '.json'), 'utf8'));
  assert.deepEqual(snap.stepTags.tagwf['arch-review'], ['review']);
  assert.deepEqual(snap.stepTags.tagwf['late-name-review'], ['coding']);
});

test('並列の子の tags: を親の step の tag として拾わない', async () => {
  // reviewers 自身には tags が無い（字下げの深い子の tags: [review] は reviewers のものではない）
  assert.deepEqual(await subPm(RUN_PARENT, 'reviewers'), { provider: 'claude', model: 'sonnet', source: 'runtime.yaml' });
});

test('workflow yaml が見つからないときは既定の profile になり、応答は 200', async () => {
  assert.deepEqual(await subPm(RUN_MISSING, 'arch-review'), { provider: 'claude', model: 'sonnet', source: 'runtime.yaml' });
  assert.deepEqual(await subPm(RUN_MISSING, 'flow-review'), { provider: 'claude', model: 'sonnet', source: 'runtime.yaml' });
});

test('tags キーの無い古い routing の控えでも落ちず、控えの既定を使う', async () => {
  assert.deepEqual(await subPm(RUN_OLDSNAP, 'arch-review'), { provider: 'claude', model: null, source: 'config' });
});

test('一度表示した run は、その後 workflow yaml の tags: を変えても表示が変わらない', async () => {
  assert.deepEqual(await subPm(RUN_KEEP, 'arch-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
  // 同じサーバー・同じ run のまま、yaml から tags を消す
  fs.writeFileSync(path.join(HOME_WF, 'keepwf.yaml'), 'name: keepwf\nsteps:\n  - name: reviewers\n    parallel:\n      fixed:\n        - name: arch-review\n');
  assert.deepEqual(await subPm(RUN_KEEP, 'arch-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
});

test('tag は最初に見つかった workflow yaml（<root>/.takt/workflows/）から引き、max_steps は今までどおり max_steps のある次の候補まで探す', async () => {
  // <root>/.takt/workflows/prjwf.yaml は tags: [review]・max_steps 無し、~/.takt/workflows/prjwf.yaml は tags: [coding]・max_steps: 7
  assert.deepEqual(await subPm(RUN_PRJ, 'arch-review'), { provider: 'codex', model: 'gpt-5', source: 'runtime.yaml' });
  assert.equal((await getState(RUN_PRJ)).active.maxSteps, 7);
});

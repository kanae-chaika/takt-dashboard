// 実行: node --test test/a11y.test.js
// 画面のキーボード操作・モーダル・ラベル（Issue #1 の指摘 11〜14）。
// bin/takt-dashboard を子プロセスで起動し、/ の HTML と、その中の <script> を node:vm で動かした結果で確認する。
// ブラウザは使えない（依存ライブラリを入れない）ので、テスト内の小さな DOM の代わり（FakeDocument）で動かす。
// FakeDocument は、ブラウザが行う次の動作だけを真似する:
//   - innerHTML を代入すると子要素を作り直す（前の要素は DOM から外れる。2 秒ごとの再描画で起きること）
//   - <dialog> だけが showModal() / close() を持つ。showModal() は中の最初のボタンへフォーカスを移し、close() は後から close イベントを出す
//   - Esc は dialog に cancel を出し、止められなければ close() する
//   - フォーカス中の <button> で Enter / Space を押すと click になる（<div> では何も起きない）
// HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startDashboard, stopDashboard } from './helpers.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo');
const RUN = path.join(REPO, '.takt', 'runs', '20261029-100000-a11y');
const META = { status: 'completed', runSlug: '20261029-100000-a11y', workflow: 'default', currentIteration: 2, startTime: '2026-10-29T01:00:00.000Z', updatedAt: '2026-10-29T01:00:10.000Z' };

// 判定（plan の approved）・エラー（implement の error）・step に付くレポート（plan.md）・未分類のレポート（other.md）がそろう run。
// status が completed なので、plan の判定はタスク欄の最終判定・タイムライン・経路のノードの 3 か所に同じ data-ji で出る
const EVENTS = [
  { type: 'step_start', step: 'plan', iteration: 1, workflow: 'default', provider: 'claude', timestamp: '2026-10-29T01:00:01.000Z' },
  { type: 'phase_start', step: 'plan', iteration: 1, phaseName: 'execute', timestamp: '2026-10-29T01:00:01.500Z' },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'execute', status: 'done', content: '計画しました', timestamp: '2026-10-29T01:00:02.000Z' },
  { type: 'phase_judge_stage', step: 'plan', iteration: 1, stage: 1, method: 'structured_output', status: 'done', response: '{"reason":"要件を満たす"}', timestamp: '2026-10-29T01:00:03.000Z' },
  { type: 'phase_complete', step: 'plan', iteration: 1, phaseName: 'judge', status: 'done', content: 'approved', timestamp: '2026-10-29T01:00:03.500Z' },
  { type: 'step_complete', step: 'plan', iteration: 1, status: 'done', timestamp: '2026-10-29T01:00:04.000Z' },
  { type: 'step_start', step: 'implement', iteration: 2, workflow: 'default', provider: 'claude', timestamp: '2026-10-29T01:00:05.000Z' },
  { type: 'phase_complete', step: 'implement', iteration: 2, phaseName: 'execute', status: 'error', error: '実装に失敗しました', timestamp: '2026-10-29T01:00:06.000Z' },
  { type: 'step_complete', step: 'implement', iteration: 2, status: 'error', content: '実装に失敗しました', timestamp: '2026-10-29T01:00:07.000Z' },
];

let server, HTML, SCRIPT;

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.join(RUN, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(RUN, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(RUN, 'meta.json'), JSON.stringify(META));
  fs.writeFileSync(path.join(RUN, 'logs', 'a.jsonl'), EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // mtime はどの step の時間帯にも入らないので、plan.md はファイル名で plan の行に付き、other.md は未分類になる
  fs.writeFileSync(path.join(RUN, 'reports', 'plan.md'), 'plan のレポート\n');
  fs.writeFileSync(path.join(RUN, 'reports', 'other.md'), 'どの step にも付かないレポート\n');
  // PATH を空にして、手元にインストールされた takt 本体を読ませない
  server = await startDashboard({ cwd: REPO, home: HOME, args: [RUN], env: { PATH: '', TAKT_DASHBOARD_ROOTS: '' } });
  HTML = await (await fetch(server.base + '/')).text();
  SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------- FakeDocument ----------

const VOID = new Set(['img', 'br', 'input', 'meta', 'link', 'hr']);
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');
const unescapeCss = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (m, hex, ch) => hex ? String.fromCodePoint(parseInt(hex, 16)) : ch);

// 複合セレクタ（tag#id.class[attr="v"]）を条件の配列にする
function parseCompound(src) {
  const conds = []; let s = src;
  const m0 = s.match(/^([a-zA-Z*][\w-]*)/); if (m0) { if (m0[1] !== '*') conds.push((el) => el.localName === m0[1].toLowerCase()); s = s.slice(m0[0].length); }
  while (s) {
    let m;
    if ((m = s.match(/^#((?:\\.|[\w-])+)/))) { const id = unescapeCss(m[1]); conds.push((el) => el.getAttribute('id') === id); }
    else if ((m = s.match(/^\.((?:\\.|[\w-])+)/))) { const c = unescapeCss(m[1]); conds.push((el) => el.classList.contains(c)); }
    else if ((m = s.match(/^\[\s*([\w-]+)\s*(?:=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\]\s]+))\s*)?\]/))) {
      const name = m[1], raw = m[2] ?? m[3] ?? m[4];
      const v = raw === undefined ? undefined : unescapeCss(raw);
      conds.push((el) => el.hasAttribute(name) && (v === undefined || el.getAttribute(name) === v));
    }
    else throw new Error('FakeDocument が扱えないセレクタ: ' + src);
    s = s.slice(m[0].length);
  }
  return (el) => conds.every((c) => c(el));
}
// セレクタを、[] と引用符の外にある区切り文字で分ける（CSS.escape は「1」を「\31 」にするので、値の中に空白が入ることがある）
function splitOutside(src, isSep) {
  const out = []; let cur = '', quote = null, depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { cur += ch + (src[i + 1] ?? ''); i++; continue; }
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (depth === 0 && isSep(ch)) { out.push(cur); out.push(ch); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
// 子孫（空白）と子（>）の結合子だけ扱う
function matchesSelector(el, selector) {
  return splitOutside(selector, (ch) => ch === ',').filter((p) => p !== ',').some((one) => {
    const parts = splitOutside(one.trim(), (ch) => /\s|>/.test(ch)).map((p) => p.trim()).filter(Boolean);
    const test = (node, i) => {
      if (!parseCompound(parts[i])(node)) return false;
      if (i === 0) return true;
      if (parts[i - 1] === '>') return node.parentElement ? test(node.parentElement, i - 2) : false;
      for (let p = node.parentElement; p; p = p.parentElement) if (test(p, i - 1)) return true;
      return false;
    };
    return test(el, parts.length - 1);
  });
}

class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, { bubbles: true, cancelable: true, key: undefined, repeat: false }, init); this.type = type; this.defaultPrevented = false; this.isStopped = false; }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.isStopped = true; }
}

class Listeners {
  constructor() { this.map = {}; }
  add(type, fn) { (this.map[type] ??= []).push(fn); }
  remove(type, fn) { this.map[type] = (this.map[type] ?? []).filter((f) => f !== fn); }
  fire(type, ev, thisArg) { for (const fn of [...(this.map[type] ?? [])]) fn.call(thisArg, ev); }
}

class FakeElement {
  constructor(doc, tag, attrs = {}) {
    this.ownerDocument = doc; this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.parentNode = null;
    this.style = {}; this._text = ''; this._html = ''; this.listeners = new Listeners();
    this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 0; this.scrollWidth = 0; this.clientHeight = 0; this.clientWidth = 0;
    if (this.localName === 'dialog') { this.open = false; this.isModal = false; this.showModalCount = 0; }
  }
  get id() { return this.attrs.id ?? ''; }
  get className() { return this.attrs.class ?? ''; }
  get classList() { const list = (this.attrs.class ?? '').split(/\s+/).filter(Boolean); return { contains: (c) => list.includes(c), add() {}, remove() {}, toggle() {} }; }
  get dataset() { const d = {}; for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith('data-')) d[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v; return d; }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument) return true; return false; }
  getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return Object.hasOwn(this.attrs, n); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._detachChildren(); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._detachChildren(); parseInto(this, this._html); }
  _detachChildren() { for (const c of this.children) { c.parentElement = null; c.parentNode = null; } this.children = []; }
  appendChild(c) { c.parentElement = this; c.parentNode = this; this.children.push(c); return c; }
  contains(n) { for (let p = n; p; p = p.parentElement) if (p === this) return true; return false; }
  descendants() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.descendants().filter((el) => matchesSelector(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) { for (let p = this; p; p = p.parentElement) if (p.matches(sel)) return p; return null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  addEventListener(t, fn) { this.listeners.add(t, fn); }
  removeEventListener(t, fn) { this.listeners.remove(t, fn); }
  dispatchEvent(ev) { return this.ownerDocument.dispatch(this, ev); }
  // ブラウザでフォーカスできる要素だけ受け付ける（href の無い <a> や tabindex の無い <div> はフォーカスできない）
  get isFocusable() { return this.localName === 'button' || this.localName === 'select' || this.hasAttribute('tabindex') || (this.localName === 'a' && this.hasAttribute('href')); }
  focus() { if (this.isConnected && this.isFocusable) this.ownerDocument._focused = this; }
  click() { this.dispatchEvent(new FakeEvent('click')); }
  showPicker() {}
  // <dialog> の動作（HTML 仕様の showModal / close / cancel のうち、このテストで使う部分）
  showModal() {
    if (this.localName !== 'dialog') throw new TypeError('showModal is not a function');
    this.showModalCount++;
    if (this.open) return;
    this.open = true; this.isModal = true;
    const first = this.descendants().find((el) => el.isFocusable || el.hasAttribute('autofocus'));
    (first ?? this).focus();
  }
  show() { if (this.localName !== 'dialog') throw new TypeError('show is not a function'); this.open = true; }
  close() {
    if (this.localName !== 'dialog') throw new TypeError('close is not a function');
    if (!this.open) return;
    this.open = false; this.isModal = false;
    // ブラウザは close イベントを後のタスクで出す
    setImmediate(() => this.dispatchEvent(new FakeEvent('close', { bubbles: false, cancelable: false })));
  }
}
// dialog と close ボタンだけ関数を持たせる（<div> に showModal があるように見せない）
for (const k of ['showModal', 'show', 'close']) {
  const impl = FakeElement.prototype[k];
  Object.defineProperty(FakeElement.prototype, k, { get() { return this.localName === 'dialog' ? impl : undefined; } });
}

// 生成される HTML の範囲で動く簡易パーサー（テキストは扱わず要素だけ作る）
function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const stack = [parent];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) { const i = stack.map((n) => n.localName).lastIndexOf(tag); if (i > 0) stack.length = i; continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = unescapeHtml(a[2] ?? a[3] ?? a[4] ?? '');
    const el = new FakeElement(doc, tag, attrs);
    stack[stack.length - 1].appendChild(el);
    if (!m[4] && !VOID.has(tag)) stack.push(el);
  }
}

class FakeDocument {
  constructor(bodyHtml) {
    this.listeners = new Listeners();
    this.body = new FakeElement(this, 'body');
    this.body.parentNode = this;
    this.body.innerHTML = bodyHtml;
    this._focused = null;
  }
  get activeElement() { return this._focused && this._focused.isConnected ? this._focused : this.body; }
  getElementById(id) { return this.body.descendants().find((el) => el.id === id) ?? null; }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  querySelector(sel) { return this.body.querySelector(sel); }
  addEventListener(t, fn) { this.listeners.add(t, fn); }
  removeEventListener(t, fn) { this.listeners.remove(t, fn); }
  // 要素 → 親 → document の順に伝える。インラインの onclick 属性（× ボタン）も実行する
  dispatch(target, ev) {
    ev.target = target;
    const path = []; for (let n = target; n; n = n.parentElement) path.push(n);
    for (const n of path) {
      ev.currentTarget = n;
      const inline = n.getAttribute('on' + ev.type);
      if (inline) new vm.Script(inline).runInContext(this.ctx);
      n.listeners.fire(ev.type, ev, n);
      if (ev.isStopped || !ev.bubbles) return !ev.defaultPrevented;
    }
    ev.currentTarget = this;
    this.listeners.fire(ev.type, ev, this);
    return !ev.defaultPrevented;
  }
}

const cssEscape = (s) => String(s).replace(/^(\d)|[^\w-]/g, (m, d) => d !== undefined ? '\\' + d.charCodeAt(0).toString(16) + ' ' : '\\' + m);

// / の HTML を読み込んだ 1 枚のページ。<script> を vm で実行し、/api/state と /api/report は起動中のサーバーに取りに行く
function loadPage() {
  const bodyHtml = HTML.match(/<body>([\s\S]*?)<script>/)[1];
  const document = new FakeDocument(bodyHtml);
  const ctx = {
    document, console, URLSearchParams, CSS: { escape: cssEscape },
    location: { search: '', pathname: '/' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (u) => fetch(server.base + u),
    // 2 秒ごとの tick はテストが rerender() で明示的に呼ぶ
    setInterval: () => 0, setTimeout,
    scrollY: 0, scrollTo() {}, addEventListener() {},
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  document.ctx = ctx;
  // 構文エラー（テンプレートリテラル内のエスケープ漏れなど）はここで投げる
  new vm.Script(SCRIPT, { filename: 'takt-dashboard-browser.js' }).runInContext(ctx);
  return { document, ctx, viewer: document.getElementById('viewer') };
}

async function waitFor(cond, what, ms = 1500) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(what + ' を待ったがタイムアウト');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = () => new Promise((r) => setImmediate(r));

// 最初の描画（読み込み時の tick）が終わったページ
async function renderedPage() {
  const page = loadPage();
  await waitFor(() => page.document.querySelector('#tl table'), '最初の描画');
  return page;
}

// フォーカスしてキーを押す。<button> ではブラウザと同じく Enter / Space が click になる
function press(page, el, key) {
  el.focus();
  const target = page.document.activeElement;
  const ev = new FakeEvent('keydown', { key });
  target.dispatchEvent(ev);
  if (!ev.defaultPrevented && target.localName === 'button' && (key === 'Enter' || key === ' ')) target.dispatchEvent(new FakeEvent('click'));
  return ev;
}
// Esc: ブラウザは keydown の後、モーダルの dialog に cancel を出し、止められなければ閉じる
function pressEscape(page) {
  const ev = new FakeEvent('keydown', { key: 'Escape' });
  page.document.activeElement.dispatchEvent(ev);
  const v = page.viewer;
  if (v.localName === 'dialog' && v.open) { const c = new FakeEvent('cancel', { bubbles: false }); v.dispatchEvent(c); if (!c.defaultPrevented) v.close(); }
}
const title = (page) => page.document.getElementById('vtitle').textContent;
// 要素どうしを assert.equal で比べると、失敗時に DOM 全体（循環参照）を表示しようとして止まるので、同一かどうかと要素の説明だけを出す
const describe = (el) => el ? el.localName + (el.className ? '.' + el.className.trim().replace(/\s+/g, '.') : '') + JSON.stringify(el.dataset) + (el.isConnected ? '' : '（DOM から外れている）') : 'null';
const assertSameElement = (actual, expected, msg = '') => assert.ok(actual === expected, msg + ' 実際: ' + describe(actual) + ' 期待: ' + describe(expected));
// 開く要素（レポート・判定・エラー）。class と data 属性で選ぶ（タグは問わない）
const openers = (page) => page.document.querySelectorAll('.rep[data-rel], .judge[data-ji], .judge[data-ei]');

// ---------- 指摘 14: run の選択のラベル ----------

test('run を選ぶプルダウン（#runsel）に aria-label「表示する run」が付いている', () => {
  const page = loadPage();
  assert.equal(page.document.getElementById('runsel').getAttribute('aria-label'), '表示する run');
});

// ---------- 指摘 12・13: モーダル ----------

test('モーダル（#viewer）は <dialog> で、再描画で置き換わる #app の外にある', () => {
  const page = loadPage();
  assert.equal(page.viewer.localName, 'dialog');
  assert.equal(page.document.getElementById('app').contains(page.viewer), false);
});

test('モーダルはタイトル（#vtitle）を名前として読ませ、× ボタンには「閉じる」という名前が付いている', () => {
  const page = loadPage();
  assert.equal(page.viewer.getAttribute('aria-labelledby'), 'vtitle');
  assert.ok(page.document.getElementById('vtitle'));
  assert.equal(page.viewer.querySelector('button[onclick="closeViewer()"]').getAttribute('aria-label'), '閉じる');
});

// ---------- 指摘 11: キーボードで開ける要素 ----------

test('レポート・判定・エラーを開く要素は、タスク欄・タイムライン・未分類のレポートのすべてで <button type="button"> になっている', async () => {
  const page = await renderedPage();
  const d = page.document;
  // fixture が想定どおりの要素を作っていることを先に確かめる（0 件だとこのテストは何も確かめない）
  assert.ok(d.querySelector('#tl .rep[data-rel="plan.md"]'), 'タイムラインのレポート');
  assert.ok(d.querySelector('#reps .rep[data-rel="other.md"]'), '未分類のレポート');
  assert.ok(d.querySelector('#tl .judge[data-ji]'), 'タイムラインの判定');
  assert.ok(d.querySelector('#tl .judge[data-ei]'), 'タイムラインのエラー');
  assert.equal(d.querySelectorAll('.judge[data-ji]').length, 2, 'タスク欄の最終判定とタイムラインの判定');
  for (const el of openers(page)) {
    assert.equal(el.localName, 'button', el.className + ' ' + JSON.stringify(el.dataset));
    assert.equal(el.getAttribute('type'), 'button', el.className + ' ' + JSON.stringify(el.dataset));
  }
});

test('経路のノードは、判定があるもの（.node.has-j）だけ role="button" tabindex="0" が付く', async () => {
  const page = await renderedPage();
  const nodes = page.document.querySelectorAll('#path .node');
  const withJudge = nodes.filter((n) => n.classList.contains('has-j'));
  const withoutJudge = nodes.filter((n) => !n.classList.contains('has-j'));
  assert.equal(withJudge.length, 1, 'plan のノード');
  assert.equal(withoutJudge.length, 1, 'implement のノード（エラーで判定なし）');
  assert.equal(withJudge[0].getAttribute('role'), 'button');
  assert.equal(withJudge[0].getAttribute('tabindex'), '0');
  assert.equal(withoutJudge[0].hasAttribute('tabindex'), false);
  assert.equal(withoutJudge[0].hasAttribute('role'), false);
});

test('クリックで、レポート・判定・エラーがモーダル表示（showModal）で開き、表示内容は今までどおり', async (t) => {
  const cases = [
    { name: 'タイムラインのレポート', sel: '#tl .rep[data-rel="plan.md"]', title: 'plan.md', body: 'plan のレポート\n' },
    { name: '未分類のレポート', sel: '#reps .rep[data-rel="other.md"]', title: 'other.md', body: 'どの step にも付かないレポート\n' },
    { name: 'タイムラインの判定', sel: '#tl .judge[data-ji]', title: 'plan の判定（iter 1）', bodyHas: 'reason: 要件を満たす' },
    { name: 'タスク欄の最終判定', sel: 'section.c2 .judge[data-ji]', title: 'plan の判定（iter 1）', bodyHas: 'reason: 要件を満たす' },
    { name: 'エラー', sel: '#tl .judge[data-ei]', title: 'implement のエラー', bodyHas: '実装に失敗しました' },
    { name: '経路のノード', sel: '#path .node.has-j', title: 'plan の判定（iter 1）', bodyHas: 'reason: 要件を満たす' },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const page = await renderedPage();
      const el = page.document.querySelector(c.sel);
      assert.ok(el, c.sel);
      el.click();
      await waitFor(() => page.viewer.open, 'モーダルが開く');
      assert.equal(page.viewer.isModal, true, 'show() ではなく showModal() で開く');
      assert.equal(title(page), c.title);
      const body = page.document.getElementById('vbody').textContent;
      if (c.body !== undefined) assert.equal(body, c.body); else assert.ok(body.includes(c.bodyHas), body);
    });
  }
});

test('フォーカスした要素で Enter を押すと開く（ボタンは標準の click、経路のノードは keydown で）', async (t) => {
  const cases = [
    { name: 'レポート', sel: '#tl .rep[data-rel="plan.md"]', title: 'plan.md' },
    { name: '判定', sel: '#tl .judge[data-ji]', title: 'plan の判定（iter 1）' },
    { name: 'エラー', sel: '#tl .judge[data-ei]', title: 'implement のエラー' },
    { name: '経路のノード', sel: '#path .node.has-j', title: 'plan の判定（iter 1）' },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const page = await renderedPage();
      const el = page.document.querySelector(c.sel);
      el.focus();
      assertSameElement(page.document.activeElement, el, 'Tab で移れる（フォーカスできる）');
      press(page, el, 'Enter');
      await waitFor(() => page.viewer.open, 'モーダルが開く');
      assert.equal(title(page), c.title);
    });
  }
});

test('経路のノードで Space を押すと判定が開き、ページのスクロール（Space の既定動作）は止める', async () => {
  const page = await renderedPage();
  const node = page.document.querySelector('#path .node.has-j');
  const ev = press(page, node, ' ');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.viewer.open, true);
  assert.equal(title(page), 'plan の判定（iter 1）');
});

test('判定が無い経路のノードやノード以外では、Enter / Space を押しても開かない', async () => {
  const page = await renderedPage();
  const plain = page.document.querySelectorAll('#path .node').find((n) => !n.classList.contains('has-j'));
  // フォーカスできない要素には keydown が届かないので、届いた場合（誤って tabindex を付けた等）を想定して直接送る
  for (const key of ['Enter', ' ']) {
    plain.dispatchEvent(new FakeEvent('keydown', { key }));
    page.document.getElementById('tl').dispatchEvent(new FakeEvent('keydown', { key }));
  }
  assert.equal(page.viewer.open, false);
});

test('開くと、フォーカスがモーダルの中へ移る', async () => {
  const page = await renderedPage();
  press(page, page.document.querySelector('#tl .judge[data-ji]'), 'Enter');
  assert.equal(page.viewer.open, true);
  assert.equal(page.viewer.contains(page.document.activeElement), true, String(page.document.activeElement.localName));
});

test('Esc・× ボタン・背景のクリックで閉じ、フォーカスは開く前の要素に戻る', async (t) => {
  const closers = {
    'Esc': (page) => pressEscape(page),
    '× ボタン': (page) => page.viewer.querySelector('.head button').click(),
    '背景のクリック': (page) => { page.viewer.dispatchEvent(new FakeEvent('mousedown')); page.viewer.dispatchEvent(new FakeEvent('click')); },
  };
  const openersBy = { 'レポート': '#tl .rep[data-rel="plan.md"]', '判定': '#tl .judge[data-ji]', 'エラー': '#tl .judge[data-ei]', '経路のノード': '#path .node.has-j' };
  for (const [how, close] of Object.entries(closers)) {
    for (const [what, sel] of Object.entries(openersBy)) {
      await t.test(what + ' を開いて ' + how + ' で閉じる', async () => {
        const page = await renderedPage();
        const el = page.document.querySelector(sel);
        press(page, el, 'Enter');
        await waitFor(() => page.viewer.open, 'モーダルが開く');
        close(page);
        await settle(); await settle();
        assert.equal(page.viewer.open, false);
        assertSameElement(page.document.activeElement, el);
      });
    }
  }
});

test('モーダルの中で押して背景で離した（文字の選択）ときは閉じない', async () => {
  const page = await renderedPage();
  press(page, page.document.querySelector('#tl .judge[data-ji]'), 'Enter');
  page.document.getElementById('vbody').dispatchEvent(new FakeEvent('mousedown'));
  page.viewer.dispatchEvent(new FakeEvent('click'));
  await settle();
  assert.equal(page.viewer.open, true);
});

test('閉じた後にもう一度開ける（閉じたときの状態が次の表示を妨げない）', async () => {
  const page = await renderedPage();
  const el = page.document.querySelector('#tl .judge[data-ji]');
  press(page, el, 'Enter');
  pressEscape(page);
  await settle(); await settle();
  press(page, page.document.querySelector('#tl .judge[data-ei]'), 'Enter');
  assert.equal(page.viewer.open, true);
  assert.notEqual(page.viewer.style.display, 'none');
  assert.equal(title(page), 'implement のエラー');
});

// ---------- 2 秒ごとの再描画をまたぐ ----------

// meta.json の updatedAt を変えて /api/state の応答を変え、tick() に #app を描き直させる
async function rerender(page, n) {
  fs.writeFileSync(path.join(RUN, 'meta.json'), JSON.stringify({ ...META, updatedAt: '2026-10-29T01:00:' + String(20 + n).padStart(2, '0') + '.000Z' }));
  await page.ctx.tick();
}

test('モーダルを開いている間に再描画が走っても、開いたまま・フォーカスはモーダルの中のまま', async () => {
  const page = await renderedPage();
  const opener = page.document.querySelector('#tl .judge[data-ji]');
  press(page, opener, 'Enter');
  const focused = page.document.activeElement;
  await rerender(page, 1);
  await settle();
  assert.equal(opener.isConnected, false, '再描画で #app の中が作り直されている（前提）');
  assert.equal(page.viewer.open, true);
  assert.equal(page.viewer.contains(page.document.activeElement), true);
  assertSameElement(page.document.activeElement, focused);
  assert.equal(title(page), 'plan の判定（iter 1）');
});

test('開いている間に再描画で開いた要素が作り直されても、閉じると作り直された同じ位置の要素にフォーカスが戻る', async (t) => {
  // plan の判定は同じ data-ji で、タスク欄（1 つ目）・タイムライン（2 つ目）・経路のノードに出る。種類と順番で見分けられることを確かめる
  const cases = [
    { name: 'タイムラインの判定（同じ data-ji の 2 つ目）', pick: (d) => d.querySelectorAll('.judge[data-ji]')[1], same: (d) => d.querySelectorAll('.judge[data-ji]')[1] },
    { name: 'タスク欄の最終判定（同じ data-ji の 1 つ目）', pick: (d) => d.querySelectorAll('.judge[data-ji]')[0], same: (d) => d.querySelectorAll('.judge[data-ji]')[0] },
    { name: '経路のノード', pick: (d) => d.querySelector('#path .node.has-j'), same: (d) => d.querySelector('#path .node.has-j') },
    { name: 'エラー', pick: (d) => d.querySelector('#tl .judge[data-ei]'), same: (d) => d.querySelector('#tl .judge[data-ei]') },
    { name: '未分類のレポート', pick: (d) => d.querySelector('#reps .rep[data-rel="other.md"]'), same: (d) => d.querySelector('#reps .rep[data-rel="other.md"]') },
  ];
  let n = 10;
  for (const c of cases) {
    await t.test(c.name, async () => {
      const page = await renderedPage();
      const d = page.document;
      const el = c.pick(d);
      press(page, el, 'Enter');
      await waitFor(() => page.viewer.open, 'モーダルが開く');
      await rerender(page, n++);
      assert.equal(el.isConnected, false, '再描画で作り直されている（前提）');
      pressEscape(page);
      await settle(); await settle();
      const expected = c.same(d);
      assert.ok(expected && expected.isConnected);
      assertSameElement(d.activeElement, expected, '戻った先');
    });
  }
});

test('#app の中の要素にフォーカスがあるときに再描画が走っても、作り直された同じ位置の要素にフォーカスが残る', async (t) => {
  const cases = [
    { name: 'タイムラインの判定（同じ data-ji の 2 つ目）', pick: (d) => d.querySelectorAll('.judge[data-ji]')[1] },
    { name: 'タスク欄の最終判定（同じ data-ji の 1 つ目）', pick: (d) => d.querySelectorAll('.judge[data-ji]')[0] },
    { name: '経路のノード', pick: (d) => d.querySelector('#path .node.has-j') },
    { name: 'エラー', pick: (d) => d.querySelector('#tl .judge[data-ei]') },
    { name: '未分類のレポート', pick: (d) => d.querySelector('#reps .rep[data-rel="other.md"]') },
  ];
  let n = 30;
  for (const c of cases) {
    await t.test(c.name, async () => {
      const page = await renderedPage();
      const d = page.document;
      const el = c.pick(d);
      el.focus();
      assertSameElement(d.activeElement, el, 'フォーカスした（前提）');
      await rerender(page, n++);
      assert.equal(el.isConnected, false, '再描画で作り直されている（前提）');
      const expected = c.pick(d);
      assert.ok(expected && expected.isConnected);
      assertSameElement(d.activeElement, expected, '再描画後のフォーカス');
    });
  }
});

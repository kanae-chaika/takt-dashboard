// レポートの Markdown プレビュー（bin/ui/app.js の renderMarkdown）が出す HTML を確認する。
// bin/takt-dashboard を子プロセスで起動し、/ の HTML の中の <script> を node:vm で動かして renderMarkdown を呼ぶ。
// 画面は使わないので、document などは「何を呼んでも自分を返す」だけの代役にする（モーダルの切替は擬似 DOM のある a11y.test.js で確認する）
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

let server, md;

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(REPO, { recursive: true });
  server = await startDashboard({ cwd: REPO, home: HOME, env: { PATH: '', TAKT_DASHBOARD_ROOTS: '' } });
  const html = await (await fetch(server.base + '/')).text();
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const any = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => any, construct: () => any, set: () => true });
  const ctx = { document: any, window: any, localStorage: any, location: { search: '' }, URLSearchParams, setInterval() {}, setTimeout() {}, fetch: () => new Promise(() => {}) };
  vm.createContext(ctx);
  new vm.Script(script, { filename: 'takt-dashboard-browser.js' }).runInContext(ctx);
  md = (text) => ctx.renderMarkdown(text);
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const link = (url, text = url) => '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';

test('見出し（# 〜 ######）は h1 〜 h6 になり、末尾の # は取る。# の後ろに空白が無い行は見出しにしない', () => {
  assert.equal(md('# タスク計画\n\n### 目的 ###\n###### 小'), '<h1>タスク計画</h1><h3>目的</h3><h6>小</h6>');
  assert.equal(md('#981 の対応'), '<p>#981 の対応</p>');
});

test('段落は空行で分かれ、段落の中の行の区切りは改行（<br>）のまま出す', () => {
  assert.equal(md('1 行目\n2 行目\n\n次の段落'), '<p>1 行目<br>2 行目</p><p>次の段落</p>');
  assert.equal(md('CRLF の行\r\n次の行'), '<p>CRLF の行<br>次の行</p>');
});

test('箇条書きは、空行なしで段落の直後に書かれていてもリストになり、字下げで入れ子になる', () => {
  assert.equal(md('次を行う。\n- a\n  - b\n    - c\n  - d\n- e'), '<p>次を行う。</p><ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>');
  assert.equal(md('* a\n+ b'), '<ul><li>a</li><li>b</li></ul>');
});

test('番号リストは ol になり、1 以外から始まる番号は start に出す。「1. 」の下を 2 文字だけ下げた箇条書きも入れ子にする', () => {
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(md('3. c\n4) d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(md('1. a\n  - b\n2. c'), '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
  assert.equal(md('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>', '種類が変わったら別のリスト');
});

test('リストの項目の中の、空行をはさんだ続きの段落・コードブロックは、その項目の中に入る', () => {
  assert.equal(md('1. a\n\n   続き\n\n   ```go\n   func f() {\n     return\n   }\n   ```\n2. b'), '<ol><li><p>a</p><p>続き</p><pre><code>func f() {\n  return\n}</code></pre></li><li>b</li></ol>');
  assert.equal(md('- a\n\n- b\n\n段落'), '<ul><li>a</li><li>b</li></ul><p>段落</p>', '項目の間の空行でリストは切れない');
});

test('チェックボックス（- [x] / - [ ]）は、操作できないチェックボックスになる', () => {
  assert.equal(md('- [x] 済み\n- [ ] まだ\n- [link] ではない'), '<ul><li class="task"><input type="checkbox" disabled checked> 済み</li><li class="task"><input type="checkbox" disabled> まだ</li><li>[link] ではない</li></ul>');
});

test('表は table になり、区切り行の : で揃えが決まる。セルの中の行内の記法も読む', () => {
  assert.equal(md('| # | 要件 | 状態 |\n|:--|:-:|--:|\n| 1 | `a` を **直す** | 済 |'),
    '<div class="md-table"><table><thead><tr><th>#</th><th class="al-c">要件</th><th class="al-r">状態</th></tr></thead><tbody><tr><td>1</td><td class="al-c"><code>a</code> を <strong>直す</strong></td><td class="al-r">済</td></tr></tbody></table></div>');
  assert.equal(md('a | b\n--|--\n1 | 2'), '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>', '行頭・行末の | が無い表');
});

test('表のセルの \\| は区切りではなく文字の | になり、<br> はセルの中の改行になる。セルが足りない行は空のセルで埋め、余りは捨てる', () => {
  assert.equal(md('| a | b |\n|---|---|\n| `x\\|y` | 1<br>2<br/>3 |\n| 足りない |\n| 1 | 2 | 余り |'),
    '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x|y</code></td><td>1<br>2<br>3</td></tr><tr><td>足りない</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>');
});

test('区切り行が無い・列の数が合わない | の行は、表にせず段落のまま出す', () => {
  assert.equal(md('a | b\nc | d'), '<p>a | b<br>c | d</p>');
  assert.equal(md('| a | b |\n|---|\n| 1 | 2 |'), '<p>| a | b |<br>|---|<br>| 1 | 2 |</p>');
});

test('コードブロック（``` / ~~~）の中身は記法として読まず、そのまま出す。閉じが無ければ最後までコードにする', () => {
  assert.equal(md('```diff\n- **a**\n+ <b>| x |</b>\n\n# 見出しではない\n```\n後ろ'), '<pre><code>- **a**\n+ &lt;b&gt;| x |&lt;/b&gt;\n\n# 見出しではない</code></pre><p>後ろ</p>');
  assert.equal(md('~~~gherkin\n```\nGiven a\n~~~'), '<pre><code>```\nGiven a</code></pre>', '~~~ の中の ``` では閉じない');
  assert.equal(md('````\n```\n````'), '<pre><code>```</code></pre>', '開始より短い ``` では閉じない');
  assert.equal(md('```\n- a\n- b'), '<pre><code>- a\n- b</code></pre>');
});

test('引用（>）は blockquote になり、中のリストなども読む。水平線（---）は hr になる', () => {
  assert.equal(md('> 1 行目 `a`\n> 2 行目\n>\n> - b\n\n---\n後ろ'), '<blockquote><p>1 行目 <code>a</code><br>2 行目</p><ul><li>b</li></ul></blockquote><hr><p>後ろ</p>');
});

test('行内: コード・太字・斜体・取り消し線。コードの中の記号は装飾にしない', () => {
  assert.equal(md('`a` と **b** と *c* と ~~d~~'), '<p><code>a</code> と <strong>b</strong> と <em>c</em> と <del>d</del></p>');
  assert.equal(md('`x*y*z` `**a**` ``a ` b``'), '<p><code>x*y*z</code> <code>**a**</code> <code>a ` b</code></p>');
  assert.equal(md('**「`deleted_at`」は未確認。**'), '<p><strong>「<code>deleted_at</code>」は未確認。</strong></p>');
});

test('行内: 装飾にしないもの（空白に挟まれた *・snake_case の _・\\ でエスケープした記号）', () => {
  assert.equal(md('(u *entities.UserMe, cw *entities.SalesReport)'), '<p>(u *entities.UserMe, cw *entities.SalesReport)</p>');
  assert.equal(md('user_id と _organization_id_ と 2 * 3 * 4'), '<p>user_id と _organization_id_ と 2 * 3 * 4</p>');
  assert.equal(md('\\*a\\* \\`b\\` \\# c'), '<p>*a* `b` # c</p>');
});

test('リンクにするのは http: / https: だけ。相対パス・javascript: などの [文字](URL) と画像は文字のまま出す', () => {
  assert.equal(md('PR [#1374](https://github.com/o/r/pull/1374) を見る'), '<p>PR ' + link('https://github.com/o/r/pull/1374', '#1374') + ' を見る</p>');
  assert.equal(md('[`a` と **b**](http://example.com/?x=1&y=2)'), '<p>' + link('http://example.com/?x=1&amp;y=2', '<code>a</code> と <strong>b</strong>') + '</p>');
  assert.equal(md('[doc](stripe_verify.md)'), '<p>[doc](stripe_verify.md)</p>');
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//example.com/x']) {
    const html = md('[押す](' + url + ')');
    assert.equal(html.includes('<a'), false, html);
  }
  assert.equal(md('![図](x.png)'), '<p>![図](x.png)</p>');
});

test('文中の URL はリンクになり、末尾の句読点・閉じ括弧・直後の日本語は URL に含めない', () => {
  assert.equal(md('https://example.com/a?b=1#c を見る'), '<p>' + link('https://example.com/a?b=1#c') + ' を見る</p>');
  assert.equal(md('（https://example.com/a）。'), '<p>（' + link('https://example.com/a') + '）。</p>');
  assert.equal(md('(see https://example.com/a_(b)). Next'), '<p>(see ' + link('https://example.com/a_(b)') + '). Next</p>');
  assert.equal(md('**https://example.com/**'), '<p><strong>' + link('https://example.com/') + '</strong></p>');
  assert.equal(md('`https://example.com/` と https://'), '<p><code>https://example.com/</code> と https://</p>', 'コードの中と、中身の無い https:// はリンクにしない');
});

test('生の HTML はタグにせず文字として出す（段落・見出し・リスト・表・引用・リンクの文字のどこでも）', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const safe = '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;';
  assert.equal(md(evil), '<p>' + safe + '</p>');
  assert.equal(md('# ' + evil), '<h1>' + safe + '</h1>');
  assert.equal(md('- ' + evil), '<ul><li>' + safe + '</li></ul>');
  assert.equal(md('> ' + evil), '<blockquote><p>' + safe + '</p></blockquote>');
  assert.equal(md('`' + evil + '`'), '<p><code>' + safe + '</code></p>');
  assert.equal(md('[' + evil + '](https://example.com/)'), '<p>' + link('https://example.com/', safe) + '</p>');
  assert.ok(md('| ' + evil + ' |\n|---|\n| ' + evil + ' |').includes('<th>' + safe + '</th></tr></thead><tbody><tr><td>' + safe + '</td>'));
  assert.equal(md('a &amp; b & c'), '<p>a &amp;amp; b &amp; c</p>', '文字参照も解釈しない');
});

test('リンクの URL から属性を足せない（" を含む URL・コードを挟んだ URL でも、href の外に出ない）', () => {
  const cases = [
    '[a](https://example.com/"onmouseover="alert(1))',
    '[a](https://example.com/`"onmouseover="alert(1)`)',
    'https://example.com/"onmouseover="alert(1)',
    'https://example.com/\'onmouseover=\'alert(1)',
    '[a](https://example.com/\\"onmouseover=alert(1))',
  ];
  for (const c of cases) {
    const html = md(c);
    for (const tag of html.match(/<a\b[^>]*>/g) ?? []) assert.match(tag, /^<a href="[^"]*" target="_blank" rel="noopener noreferrer">$/, c + ' → ' + html);
    assert.equal(/<[^>]*\son\w+=/i.test(html), false, c + ' → ' + html);
  }
});

test('変換の途中で使う目印の文字（U+E000）が入力に入っていても、ほかの箇所の HTML を差し込めない', () => {
  assert.equal(md('`<b>` 0 1'), '<p><code>&lt;b&gt;</code> 0 1</p>');
});

test('入れ子が深すぎる引用・リストや、長い入力でも止まらずに返す', () => {
  assert.equal(typeof md('>'.repeat(5000) + ' a'), 'string');
  assert.equal(typeof md(Array.from({ length: 300 }, (_, i) => ' '.repeat(i * 2) + '- a').join('\n')), 'string');
  assert.equal(typeof md('*a `b **c ~~d [e](https://'.repeat(3000)), 'string');
  assert.equal(md(''), '');
});

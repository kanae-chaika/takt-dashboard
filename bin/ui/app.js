const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const escA = (s) => esc(s).replace(/"/g,'&quot;');
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('button.rep[data-rel]'); if (t) { noteOpener(t); openReport(t.dataset.rel); }
  const j = e.target.closest && e.target.closest('button.judge[data-ji]'); if (j) { noteOpener(j); openJudge(TL[Number(j.dataset.ji)]); }
  const er = e.target.closest && e.target.closest('button.judge[data-ei]'); if (er) { noteOpener(er); openError(TL[Number(er.dataset.ei)]); }
});
let TL = []; // 描画中のタイムライン行（判定の詳細をクリックで開くために保持）
let LATEST = -1; // TL の中で一番新しい行の index
const jst = (ts) => ts ? new Date(ts).toLocaleTimeString('ja-JP', { hour12:false }) : '';
// 開始日時。分まで（一覧で run を見分けるのに秒は要らない）。jst と同じくブラウザのタイムゾーンで出す。meta.json に startTime が無い・日時として読めない run は空にする（文字列・数値以外は Date に渡さない。{"toString":null} のような値は new Date が例外を投げ、一覧の描画が止まるため）
const startMs = (ts) => ts && (typeof ts === 'string' || typeof ts === 'number') ? new Date(ts).getTime() : NaN;
const startAt = (ts, hasYear) => { const d = new Date(startMs(ts)); if (isNaN(d)) return ''; const p = (n) => String(n).padStart(2,'0'); return (hasYear ? d.getFullYear()+'/' : '') + p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); };
const fmt = (ms) => { const s=Math.max(0,Math.floor(ms/1000)); return Math.floor(s/60)+'分'+String(s%60).padStart(2,'0')+'秒'; };
// ログに provider/model の記録が無い行（並列の子）は設定から引いた値。表示は同じにし、出どころは title（hover）だけで示す
function pm(r){
  const cur = esc(r.provider ?? '?') + (r.model ? '/' + esc(r.model) : ''); // model 未指定（provider の既定）は provider 名だけ
  if (r.switchFrom) return '<span class="sw" title="レート上限などで切替">'+esc(r.switchFrom)+' → '+cur+'</span>'; // 切替があった開始行は黄色で「切替前 → 切替後」
  // provider が無いのは、設定の書き方（ladder・pool・assignments・personas）からは決まらないとき。takt の logging.usage_events を有効にすると実際の値が出る
  const t = r.source==='log' ? '' : r.provider == null ? ' title="設定（'+escA(r.source)+'）からは判別できないため不明。takt の logging.usage_events を有効にすると実際の値を表示"' : ' title="実行ログに記録が無いため設定（'+escA(r.source)+'）からの推定"';
  return '<span'+t+'>'+cur+'</span>';
}
function repLinks(r){ return (r.reports||[]).map(rel => '<button type="button" class="rep" data-rel="'+escA(rel)+'">'+esc(rel.split('/').pop())+'</button>').join(' '); }
// 判定ラベルの色分け。タイムライン・タスク欄のボタンと経路のノードで同じ分類にする（needs_fix は takt の「修正が要る」判定なので reject と同じ赤）
const judgeClass = (label) => /^approve/i.test(label) ? 'j-approved' : /^(reject|needs_fix)/i.test(label) ? 'j-rejected' : '';
// 判定結果のラベル（rule 名そのまま）。クリックで judge の reason を開く。ラベルが無く stage だけある場合は「判定」
function judgeLink(r, i){
  if ((!r.judge || (!r.judge.label && !r.judge.stages.length)) && r.errors && r.errors.length) return '<button type="button" class="judge j-rejected" data-ei="'+i+'" title="クリックでエラーの内容を表示">エラー</button>';
  if (!r.judge || (!r.judge.label && !r.judge.stages.length)) return '';
  const label = r.judge.label || '判定ログ';
  const cls = judgeClass(label);
  return '<button type="button" class="judge '+cls+'" data-ji="'+i+'" title="'+escA(label)+'（クリックで判定理由を表示）">'+esc(label)+'</button>';
}
function openJudge(r){
  const j = r.judge;
  const lines = ['一致した rule: ' + (j.label ?? '(記録なし)'), ''];
  for (const s of j.stages) {
    lines.push('stage ' + (s.stage ?? '?') + ' · ' + (s.method ?? '?') + ' · ' + (s.status ?? '?'));
    let parsed = null; try { parsed = JSON.parse(s.response); } catch {}
    if (parsed && typeof parsed === 'object') for (const [k, v] of Object.entries(parsed)) lines.push('  ' + k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
    else lines.push('  ' + s.response);
    lines.push('');
  }
  const [it, attempt] = ((r.key||'').split('#')[1] || '').split('@'); // key は step#iter または step#iter@n（n 回目の試行）
  document.getElementById('vtitle').textContent = r.step + ' の判定（iter ' + it + (attempt ? '・' + attempt + ' 回目' : '') + '）';
  fillViewer(lines.join('\n'), '14px'); // 判定の理由は短い文章なのでレポートより大きく
  showViewer();
}
// ---------- タイムラインの高さ（下端のバーをドラッグ。localStorage に保存） ----------
// 上段（実行中のタスク + タイムライン）は一体で、下のバーをドラッグすると両方の高さが変わる。経路はそれに合わせて上下する
// 高さの範囲。下限はタイムラインの見出しと数行が残る高さ。上限は aria-valuemax のために決めたもの（省略すると 100 と解釈され、既定の 460 が範囲外になる）で、
// ドラッグ・キー操作とも同じ値で止める
const TL_H_MIN = 180, TL_H_MAX = 2000;
const clampRowH = (h) => Math.min(TL_H_MAX, Math.max(TL_H_MIN, h));
// 保存済みの値も範囲に収める（上限が無かった版で保存した大きな値や、手で書き換えた値が aria-valuemax を超えないように）
let TL_H = 460; try { TL_H = clampRowH(Number(localStorage.getItem('tlH')) || 460); } catch {}
function applyRowH(){
  for (const el of document.querySelectorAll('section.toprow')) el.style.height = TL_H + 'px'; const tl = document.getElementById('tl'); if (tl) tl.style.height = (TL_H - 62) + 'px';
  const rz = document.getElementById('tlrz'); if (rz) { rz.setAttribute('aria-valuenow', String(TL_H)); rz.setAttribute('aria-valuetext', TL_H + 'px'); } // 読み上げに今の高さを伝える
}
function resetRowH(){ TL_H = 460; applyRowH(); try { localStorage.removeItem('tlH'); } catch {} drawEdges(); }
document.addEventListener('dblclick', (e) => { if (e.target.id === 'tlrz') resetRowH(); }); // ダブルクリックで既定の高さに戻す
// マウスを使えない人もバーで高さを変えられるようにする: ↓ / ↑ で 20px ずつ（範囲はドラッグと同じ）、Enter で既定に戻す（ダブルクリックと同じ）。
// 矢印キーの既定動作（ページのスクロール）は止める。バー自身がフォーカスされているときだけ反応する
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'tlrz') return;
  if (e.key === 'Enter') { e.preventDefault(); resetRowH(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  TL_H = clampRowH(TL_H + (e.key === 'ArrowDown' ? 20 : -20)); applyRowH();
  try { localStorage.setItem('tlH', String(TL_H)); } catch {}
  drawEdges();
});
document.addEventListener('mousedown', (e) => {
  if (!(e.target.id === 'tlrz')) return;
  e.preventDefault();
  const y0 = e.clientY, h0 = TL_H;
  const move = (ev) => { TL_H = clampRowH(Math.round(h0 + ev.clientY - y0)); applyRowH(); };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; try { localStorage.setItem('tlH', String(TL_H)); } catch {} drawEdges(); };
  document.body.style.cursor = 'row-resize';
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});
// ---------- Markdown のプレビュー（レポート） ----------
// レポート（takt のエージェントが書く Markdown）を HTML にする。依存ライブラリを入れない方針なので、実際のレポートで使われている記法だけを自前で読む:
// 見出し（#）・段落・箇条書き / 番号リスト（入れ子・チェックボックス）・表・コードブロック（``` / ~~~）・引用・水平線、
// 行内は `コード`・**太字**・*斜体*・~~取り消し線~~・[リンク](URL)・URL・<br>・\ によるエスケープ。それ以外（画像・脚注・生の HTML など）は文字のまま出す
// レポートは LLM の出力なので、本文は必ず esc() を通してから組み立てる（生の HTML はタグにしない）。リンクにするのは http: / https: だけ
const MD_MAX_DEPTH = 16; // 引用・リストの入れ子の上限。これより深い部分は文字のまま出す（> を大量に重ねた入力で再帰が深くなりすぎないように）
const MD_HOLD = ''; // 変換済みの HTML を置いておく目印（私用領域の文字。入力からは取り除く）
const MD_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/, MD_HEAD = /^ {0,3}(#{1,6})[ \t]+(.*)$/, MD_HR = /^ {0,3}([-*_])(?: *\1){2,} *$/, MD_QUOTE = /^ {0,3}>/;
const MD_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*))?$/, MD_DELIM = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const mdIndent = (l) => l.length - l.trimStart().length;
const mdLink = (url, inner) => '<a href="' + escA(url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
// 太字・斜体・取り消し線。esc() 済みの文字列に掛ける。_斜体_ は読まない（snake_case の識別子が斜体になるため。実際のレポートでも使われていない）
const mdEmph = (h) => h.replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>').replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>');
function mdInline(src){
  // コード・リンクは、変換した HTML を held に置いて目印に差し替える（中の * や URL を、後の変換がもう一度触らないように）。最後に戻す
  const held = [];
  const hold = (html) => MD_HOLD + (held.push(html) - 1) + MD_HOLD;
  let s = String(src).replaceAll(MD_HOLD, '');
  // \ によるエスケープと `コード`。左から順に読む（\` はコードを始めず、コードの中の \ はそのまま）
  s = s.replace(/\\([!-/:-@[-`{-~])|(`+)([^`]|[^`].*?[^`])\2(?!`)/g, (m, ch, tick, code) => hold(ch !== undefined ? esc(ch) : '<code>' + esc(code.replace(/^ (.*[^ ].*) $/, '$1')) + '</code>'));
  // [文字](URL)。http / https 以外（相対パス・javascript: など）と画像（![…](…)）は文字のまま。URL に目印（コード等）が混ざるものも通さない（属性の中に HTML を戻さない）
  s = s.replace(/(!?)\[([^\]]+)\]\(([^)\s]+)\)/g, (m, bang, text, url) => bang || !/^https?:\/\//i.test(url) ? m : hold(mdLink(url, mdEmph(esc(text)))));
  // 文中の URL。URL に使える ASCII の文字だけを取り、末尾の句読点・閉じ括弧は URL に含めない（日本語の文は URL の直後に文字が続くため）
  s = s.replace(/https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/gi, (m) => {
    let u = m;
    while (/[.,;:!?'*]$/.test(u) || (u.endsWith(')') && u.split(')').length > u.split('(').length) || (u.endsWith(']') && u.split(']').length > u.split('[').length)) u = u.slice(0, -1);
    return /^https?:\/\/./i.test(u) ? hold(mdLink(u, esc(u))) + m.slice(u.length) : m;
  });
  // 残りをエスケープしてから装飾する。生の HTML のうち <br> だけは改行にする（表のセルの中の改行に使われている）
  s = mdEmph(esc(s)).replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  const restore = (t) => t.replace(/(\d+)/g, (m, i) => restore(held[i]));
  return restore(s);
}
// 表の 1 行をセルに分ける。\| は区切りではなく文字の |（GFM と同じく、コードの中の | も \| と書かれている）
function mdCells(line){
  const s = line.trim(), cells = []; let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; }
    else if (s[k] === '|') { cells.push(cur); cur = ''; }
    else cur += s[k];
  }
  cells.push(cur);
  if (cells.length > 1 && cur === '' && s.endsWith('|')) cells.pop(); // 行末の | の後ろ
  if (s.startsWith('|')) cells.shift(); // 行頭の | の前
  return cells.map((c) => c.trim());
}
// 表の始まり: | を含む行の次が区切り行（|---|:--:|）で、列の数が同じ
const mdIsTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && MD_DELIM.test(lines[i + 1]) && mdCells(lines[i]).length === mdCells(lines[i + 1]).length;
// 段落を終わらせる行。箇条書きの前に空行を入れないレポートが多いので、リストも段落を終わらせる
const mdStartsBlock = (lines, i) => MD_FENCE.test(lines[i]) || MD_HEAD.test(lines[i]) || MD_HR.test(lines[i]) || MD_QUOTE.test(lines[i]) || MD_ITEM.test(lines[i]) || mdIsTable(lines, i);
// isTight: 空行の無いリスト項目の中。段落を <p> で包まない（項目ごとに段落の余白が付かないように）
function mdBlocks(lines, depth, isTight){
  if (depth > MD_MAX_DEPTH) return '<p>' + lines.map(esc).join('<br>') + '</p>';
  let out = '', i = 0;
  while (i < lines.length) {
    const line = lines[i]; let m;
    if (!line.trim()) { i++; continue; }
    // コードブロック。開始と同じ記号が同じ数以上並ぶ行まで（閉じが無ければ最後まで）。中身は開始行の字下げぶんだけ左に寄せる（リストの中のコードブロック）
    if ((m = MD_FENCE.exec(line)) && !(m[1][0] === '`' && m[2].includes('`'))) {
      const ind = mdIndent(line), close = new RegExp('^ *' + m[1][0] + '{' + m[1].length + ',} *$'), code = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i].slice(Math.min(ind, mdIndent(lines[i]))));
      i++;
      out += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'; continue;
    }
    if ((m = MD_HEAD.exec(line))) { out += '<h' + m[1].length + '>' + mdInline(m[2].replace(/[ \t]+#+[ \t]*$/, '').trim()) + '</h' + m[1].length + '>'; i++; continue; }
    if (MD_HR.test(line)) { out += '<hr>'; i++; continue; }
    if (MD_QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && MD_QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
      out += '<blockquote>' + mdBlocks(inner, depth + 1) + '</blockquote>'; continue;
    }
    if (mdIsTable(lines, i)) {
      const head = mdCells(line), align = mdCells(lines[i + 1]).map((c) => c.startsWith(':') && c.endsWith(':') ? ' class="al-c"' : c.endsWith(':') ? ' class="al-r"' : '');
      const row = (cells, tag) => '<tr>' + head.map((h, k) => '<' + tag + align[k] + '>' + mdInline(cells[k] ?? '') + '</' + tag + '>').join('') + '</tr>'; // 列の数は見出しに合わせる（足りないセルは空、余りは捨てる）
      let body = '';
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) body += row(mdCells(lines[i]), 'td');
      out += '<div class="md-table"><table><thead>' + row(head, 'th') + '</thead><tbody>' + body + '</tbody></table></div>'; continue;
    }
    // リスト。同じ字下げ・同じ種類（- と 1.）の行が項目で、それより字下げの深い行は直前の項目の中身（入れ子のリスト・続きの段落・コードブロック）。
    // 「1. 」の下を 2 文字だけ下げて書くレポートもあるので、CommonMark より緩く、少しでも深ければ中身とする
    if ((m = MD_ITEM.exec(line))) {
      const base = m[1].length, isOl = /\d/.test(m[2]);
      const isItem = (l) => { const x = MD_ITEM.exec(l); return !!x && x[1].length === base && /\d/.test(x[2]) === isOl && !MD_HR.test(l); };
      const next = (k) => { while (k < lines.length && !lines[k].trim()) k++; return k; }; // 空行を飛ばした次の行
      out += isOl ? '<ol' + (parseInt(m[2], 10) === 1 ? '' : ' start="' + parseInt(m[2], 10) + '"') + '>' : '<ul>';
      while (i < lines.length && isItem(lines[i])) {
        const x = MD_ITEM.exec(lines[i]), off = base + x[2].length + 1, body = [x[3] ?? ''];
        for (i++; i < lines.length; i++) {
          const k = next(i); // 空行は、その先に項目の中身が続くときだけ中身に入れる
          if (k >= lines.length || mdIndent(lines[k]) <= base) break;
          body.push(lines[i].slice(Math.min(off, mdIndent(lines[i]))));
        }
        const task = /^\[([ xX])\](?: +|$)/.exec(body[0]); if (task) body[0] = body[0].slice(task[0].length);
        out += (task ? '<li class="task"><input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '> ' : '<li>') + mdBlocks(body, depth + 1, !body.some((l) => !l.trim()) || body.length === 1) + '</li>';
        const k = next(i); if (k < lines.length && isItem(lines[k])) i = k; // 項目の間の空行
      }
      out += isOl ? '</ol>' : '</ul>'; continue;
    }
    // 段落。行の区切りは改行のまま出す（日本語の文は行をつなぐと余計な空白が入る。元のテキストと行が対応していたほうが見比べやすい）
    const para = [line.trim()];
    for (i++; i < lines.length && lines[i].trim() && !mdStartsBlock(lines, i); i++) para.push(lines[i].trim());
    const html = para.map(mdInline).join('<br>');
    out += isTight ? html : '<p>' + html + '</p>';
  }
  return out;
}
// 行頭のタブは 4 文字の字下げとして読む
function renderMarkdown(text){ return mdBlocks(String(text).split(/\r?\n/).map((l) => l.replace(/^[ \t]+/, (w) => w.replaceAll('\t', '    '))), 0, false); }
// ---------- 経路表示 ----------
// タイムラインの行から経路のモデルを作る。通常ステップは箱、並列ステップは枠（中に子の箱）。リトライは同じステップの箱がもう 1 つ並ぶ
function pathModel(tl, meta){
  const nodes = []; let open = null;
  const st = (status) => status==='done' ? 'done' : status==='rate_limited' ? 'warn' : status ? 'err' : (meta.status==='running' ? 'run' : meta.status==='interrupted' ? 'intr' : 'err');
  tl.forEach((r, i) => {
    if (r.kind==='step') { open = { kind:'step', key:r.key, name:r.step, workflow:r.workflow, iter:r.iteration, pm:r, ts:r.ts, status:null, label:null, ji:-1, children:[] }; nodes.push(open); }
    else if (r.kind==='sub') { if (open) { open.kind = 'parallel'; open.children.push({ key:r.key, name:r.step, pm:r, ts:r.ts, status:null, label:null, ji:-1 }); } }
    else if (r.kind==='phase') { const c = open && open.children.find((x) => x.key===r.key); if (c) { c.tsEnd = r.ts; if (r.status==='rate_limited') c.status='rate_limited'; else if (r.status==='error') c.status='error'; if (r.phase==='judge' && r.status==='done') { c.status='done'; c.label=r.judge?.label ?? null; c.ji = r.judge ? i : -1; } } }
    else if (r.kind==='done') { const n = [...nodes].reverse().find((x) => x.key===r.key && x.status===null); if (n) { n.status=r.status; n.tsEnd=r.ts; n.label=r.judge?.label ?? null; n.ji = r.judge ? i : -1; if (n===open) open = null; } }
    else if (r.kind==='end') { nodes.push({ kind:'end', name: r.status==='interrupted' ? '中断' : r.status, status: r.status, reason:r.reason, ts:r.ts, ji: r.judge ? i : -1, children:[] }); }
  });
  for (const n of nodes) { n.cls = n.kind==='end' ? (n.status==='interrupted' ? 'intr' : 'err') : st(n.status); for (const c of n.children) c.cls = st(c.status); }
  return nodes;
}
function cardHtml(n, big, edge=''){ // edge: 経路の端の印（' first' / ' last'）。端のポートを出さないために使う
  const j = n.ji>=0 ? ' has-j" role="button" tabindex="0" data-ji="'+n.ji : ''; // 判定を開けるノードだけキーボードで操作できるようにする
  const t = ' title="'+escA((n.ts?jst(n.ts):'')+(n.tsEnd?' → '+jst(n.tsEnd):''))+'"';
  const jc = n.label && judgeClass(n.label) ? ' ' + judgeClass(n.label) : '';
  const label = n.label ? '<span class="jl'+jc+'" title="'+escA(n.label)+'">'+esc(n.label)+'</span>' : (n.reason ? '<span class="jl">'+esc(n.reason)+'</span>' : '<span class="muted">'+esc(n.status ?? (n.cls==='run'?'実行中':''))+'</span>');
  return '<div class="node st-'+n.cls+edge+j+'"'+t+'><span class="port prev"></span><span class="port next"></span>'
    + '<div class="nm">'+esc(n.name)+(big && n.workflow && n.workflow!=='default' ? ' <span class="wf">['+esc(n.workflow)+']</span>' : '')+(big && n.iter ? ' <span class="wf">· '+esc(n.iter)+'/'+(MAX ?? '?')+'</span>' : '')+'</div>'
    + '<div class="sv"><span class="dot"></span>'+label+'</div>'
    + (n.pm ? '<div class="pmv">'+pm(n.pm)+'</div>' : '') + '</div>';
}
function pathHtml(nodes){
  const edgeOf = (i) => (i===0 ? ' first' : '') + (i===nodes.length-1 ? ' last' : '');
  return '<div class="lane">' + nodes.map((n, i) => n.kind==='parallel'
    ? '<div class="group st-'+n.cls+edgeOf(i)+'"><span class="gl">parallel · '+esc(n.name)+(n.iter ? ' · '+esc(n.iter)+'/'+(MAX ?? '?') : '')+(n.status && n.status!=='done' ? ' · <span class="jl">'+esc(n.status==='rate_limited' ? 'rate_limited → リトライ' : n.status)+'</span>' : '')+'</span>'+n.children.map((c) => cardHtml(c, false)).join('')+'</div>'
    : cardHtml(n, true, edgeOf(i))).join('') + '<svg class="edges"></svg></div>';
}
// ポート同士を線で結ぶ。並列の枠は「前の箱 → 各子」「各子 → 次の箱」に扇状に広げる（公式の実行経路と同じ）
function drawEdges(){
  const lane = document.querySelector('#path .lane'); if (!lane) return;
  // 横スクロールが出て、かつバーが常時表示の従来型（場所を取る。offsetHeight と clientHeight の差がバーの太さ）のときだけ下に余白を足す。
  // 余白が無いと並列の枠の点線（一番下に来る要素）がバーに密着する。オーバーレイ型（macOS の既定。スクロール中だけ表示）は
  // バーが消えれば点線が見えるので足さない。見えていない間もずっと余白が空くのを避けるため。スクロールしないときも足さず、見た目を変えない
  const path = lane.parentElement; path.style.paddingBottom = path.scrollWidth > path.clientWidth && path.offsetHeight !== path.clientHeight ? '12px' : '';
  const svg = lane.querySelector('svg.edges'); const L = lane.getBoundingClientRect();
  svg.setAttribute('width', lane.scrollWidth); svg.setAttribute('height', lane.scrollHeight);
  const pt = (el, side) => { const r = el.querySelector('.port.'+side).getBoundingClientRect(); return [r.left + r.width/2 - L.left, r.top + r.height/2 - L.top]; };
  const items = [...lane.children].filter((el) => el.classList.contains('node') || el.classList.contains('group'));
  const outs = (el) => el.classList.contains('group') ? [...el.querySelectorAll('.node')] : [el];
  let d = '';
  const curve = (x1,y1,x2,y2,cls) => { const dx = Math.max(18, (x2-x1)/2); return '<path'+(cls?' class="'+cls+'"':'')+' d="M'+x1+' '+y1+' C'+(x1+dx)+' '+y1+' '+(x2-dx)+' '+y2+' '+x2+' '+y2+'"/>'; };
  for (let i = 0; i < items.length - 1; i++) {
    const A = outs(items[i]), B = outs(items[i+1]);
    if (A.length > 1 && B.length > 1) {
      // 並列 → 並列（リトライなど）は総当たりで線が絡むので、中間の 1 点に集めてから広げる
      const pa = A.map((a) => pt(a,'next')), pb = B.map((b) => pt(b,'prev'));
      const mx = (Math.max(...pa.map((q) => q[0])) + Math.min(...pb.map((q) => q[0]))) / 2;
      const my = (pa.reduce((t,q) => t+q[1], 0)/pa.length + pb.reduce((t,q) => t+q[1], 0)/pb.length) / 2;
      pa.forEach(([x,y], k) => { d += curve(x,y,mx,my, A[k].classList.contains('st-done') ? 'e-done' : ''); });
      pb.forEach(([x,y]) => { d += curve(mx,my,x,y,''); });
      d += '<circle cx="'+mx+'" cy="'+my+'" r="3" fill="var(--dim)"/>';
      continue;
    }
    for (const a of A) for (const b of B) { const [x1,y1] = pt(a,'next'), [x2,y2] = pt(b,'prev'); d += curve(x1,y1,x2,y2, a.classList.contains('st-done') ? 'e-done' : ''); }
  }
  svg.innerHTML = d;
}
window.addEventListener('resize', drawEdges);
function openNode(n){ noteOpener(n); openJudge(TL[Number(n.dataset.ji)]); }
document.addEventListener('click', (e) => { const n = e.target.closest && e.target.closest('.node.has-j'); if (n) openNode(n); });
// role="button" の <div> は Enter / Space で click にならないので自分で開く。Space の既定動作（ページのスクロール）は止める。
// ノード自身がフォーカスされているときだけ反応する（モーダルの中などで押したキーを拾わないように）
document.addEventListener('keydown', (e) => { const n = e.target; if ((e.key === 'Enter' || e.key === ' ') && n.matches && n.matches('.node.has-j')) { e.preventDefault(); openNode(n); } });
function openError(r){
  const lines = [];
  for (const e of r.errors) { lines.push(jst(e.ts) + '  ' + e.phase + ' → ' + e.status); lines.push(e.text); lines.push(''); }
  document.getElementById('vtitle').textContent = r.step + ' のエラー';
  fillViewer(lines.join('\n'), '13px');
  showViewer();
}
function rowHtml(r, i){
  if (r.kind==='step') return '<tr'+(i===LATEST?' class="latest"':'')+'><td class="ts">'+jst(r.ts)+'</td><td class="step">▶ '+esc(r.step)+(r.workflow&&r.workflow!=='default'?' <span class="muted">['+esc(r.workflow)+']</span>':'')+' <span class="muted">· '+esc(r.iteration)+'/'+(MAX ?? '?')+'</span></td><td class="pm">'+pm(r)+'</td><td class="reps" colspan="2">'+repLinks(r)+'</td></tr>';
  if (r.kind==='sub')  return '<tr'+(i===LATEST?' class="latest"':'')+'><td class="ts">'+jst(r.ts)+'</td><td class="sub">├▶ '+esc(r.step)+'</td><td class="pm">'+pm(r)+'</td><td class="reps" colspan="2">'+repLinks(r)+'</td></tr>';
  if (r.kind==='phase') {
    // エラーは本文を長々と出さず、「エラー」リンク + 先頭 80 文字。全文はクリックでモーダル
    // レポートのリンクは report フェーズの終了行に出す（開始行と同じ列）。リンクが無い行は td にクラスを付けず、今までの折り返しのまま
    const reps = repLinks(r);
    const tail = '<td>'+esc(r.phase)+' → '+esc(r.status)+'</td><td'+(reps?' class="reps"':'')+' colspan="2">'+(r.error?judgeLink(r, i)+' <span class="err">'+esc(r.error.slice(0,80))+(r.error.length>80?'…':'')+'</span>':judgeLink(r, i))+(reps?' '+reps:'')+'</td></tr>';
    // 木の中の行: 左端の時刻列は空け、枝（├ / └）の後ろに終了時刻を置く（左端に時刻があるのは開始・完了の行だけ）
    if (r.tree && r.status!=='rate_limited') return '<tr class="phase'+(i===LATEST?' latest':'')+'"><td class="ts"></td><td class="sub">&nbsp;&nbsp;&nbsp;&nbsp;'+r.tree+'<span class="ts">'+jst(r.ts)+'</span></td>'+tail;
    return '<tr class="'+(r.status==='rate_limited'?'warn':'phase')+(i===LATEST?' latest':'')+'"><td class="ts">'+jst(r.ts)+'</td><td class="sub">'+(r.status==='rate_limited'?'⚠':'│')+' '+esc(r.step)+'</td>'+tail;
  }
  if (r.kind==='switch') return '<tr class="warn"><td class="ts">'+jst(r.ts)+'</td><td class="'+(r.top?'step':'sub')+'">⚠ '+esc(r.step)+'</td><td class="pm" colspan="3">'+esc(r.from)+' → <b>'+esc(r.to)+'</b></td></tr>';
  if (r.kind==='done') {
    const rl = r.status==='rate_limited';
    // レポートのリンクは完了の行に出す。判定を provider の列、リンクを開始行のリンクと同じ列に置く。リンクが無い行は今までどおり 1 つのセル
    const reps = repLinks(r);
    const label = rl ? 'rate_limited'+(r.rateProvider?'（'+esc(r.rateProvider)+'）':'')+' → リトライ'
                     : '→ '+esc(r.status);
    return '<tr class="'+(rl?'warn':(r.status==='done'?'done':'alert'))+(i===LATEST?' latest':'')+'"><td class="ts">'+jst(r.ts)+'</td><td class="step">'+(rl?'⚠':'■')+' '+esc(r.step)+' <span style="font-weight:normal">'+label+'</span></td>'+(reps?'<td>'+judgeLink(r, i)+'</td><td class="reps" colspan="2">'+reps+'</td>':'<td colspan="3">'+judgeLink(r, i)+'</td>')+'</tr>';
  }
  if (r.kind==='end') {
    const intr = r.status==='interrupted';
    return '<tr class="'+(intr?'interrupted':'alert')+(i===LATEST?' latest':'')+'"><td class="ts">'+jst(r.ts)+'</td><td class="step" colspan="4">'+(intr?'⏹ 中断':'✖ '+(r.status==='failed'?'失敗':r.status==='aborted'?'中止':esc(r.status)))+' <span style="font-weight:normal">'+esc(r.step)+(r.reason?(r.step?'':' ')+'（'+esc(r.reason)+'）':'')+'</span> '+judgeLink(r, i)+'</td></tr>'; // ステップに入る前の失敗（provider 未インストール等）はステップ名が無く理由だけ
  }
  return '<tr class="alert"><td class="ts">'+jst(r.ts)+'</td><td colspan="4">‼ '+esc(r.type)+' '+esc(r.step)+' '+esc(r.reason)+' '+esc(r.error.slice(0,300))+'</td></tr>';
}
async function openReport(rel){
  const gen = viewerGen;
  let r = null; // 取得できなければ null（サーバー停止・ネットワーク断）
  try { const res = await fetch('/api/report?p='+encodeURIComponent(rel)+(shownRun ? '&run='+encodeURIComponent(shownRun) : '')); r = { ok: res.ok, status: res.status, text: await res.text() }; } catch {}
  if (gen !== viewerGen) return; // 取得を待つ間に別のレポート・判定を開いていたら、古い応答で中身と開いた要素を上書きしない
  // サーバーはレポート・run が無いと 404（本文 not found）、処理の失敗で 500（本文 internal error）を返す。その本文をレポートとして見せない
  const t = !r ? 'レポートを取得できません' : r.status === 404 ? 'レポートが見つかりません' : !r.ok ? 'レポートを取得できません' : r.text;
  document.getElementById('vtitle').textContent = rel;
  fillViewer(t, '', r && r.ok); // プレビューにするのは取得できたレポートだけ（エラー文は元のテキストのまま）
  showViewer();
}
// #app の中でフォーカスできる要素（開く要素と、上段の高さを変えるバー）の種類と、それを見分ける属性
const FOCUS_KINDS = [['button.rep', 'data-rel'], ['button.judge', 'data-ji'], ['button.judge', 'data-ei'], ['.node.has-j', 'data-ji'], ['#tlrz', 'id']];
// data-ji / data-ei は TL の添字。再描画で前に行が入る（並列の子のフェーズ行は子の直後にまとめる等）と添字がずれるので、行そのものを表す値で見分ける
function focusKey(el, attr){
  const v = el.getAttribute(attr); if (attr !== 'data-ji' && attr !== 'data-ei') return v; // data-rel・id は値そのもので見分けられる
  const r = TL[Number(v)]; return r ? [r.kind, r.key ?? r.step, r.phase ?? '', r.ts ?? ''].join('|') : null;
}
// 2 秒ごとの再描画で #app が作り直されると元の要素は DOM から外れるので、種類・行・表示箇所・「その中の何番目か」を覚えて探し直す
// （同じ判定がタスク欄・タイムライン・経路に出るので、種類・表示箇所・番目で見分ける）。TL を描き直す前に呼ぶこと。FOCUS_KINDS の要素でなければ null
function locate(el){
  for (const [sel, attr] of FOCUS_KINDS) {
    const full = sel + '[' + attr + ']';
    if (!el.matches(full)) continue;
    const key = focusKey(el, attr), area = areaOf(el);
    return { el, full, attr, key, area, index: sameAs(full, attr, key, area).indexOf(el) };
  }
  return null;
}
// 表示箇所（タイムライン・経路・未分類のレポート・それ以外=タスク欄）。run が完了するとタスク欄に最終判定が増え、番目だけでは別の箇所の同じ判定に移ってしまうため
function areaOf(el){ const c = el.closest('#tl, #path, #reps'); return c ? c.id : ''; }
function sameAs(full, attr, key, area){ return [...document.querySelectorAll(full)].filter((x) => focusKey(x, attr) === key && areaOf(x) === area); }
// 元の表示箇所に無ければ（未分類だったレポートがログの追加でタイムラインに移った等）、ほかの表示箇所の同じ要素に戻す
function relocate(o){ return sameAs(o.full, o.attr, o.key, o.area)[o.index] ?? [...document.querySelectorAll(o.full)].find((x) => focusKey(x, o.attr) === o.key); }
// モーダルを開いた要素。閉じたらそこへフォーカスを戻す。
// openReport は fetch を待ってから開くので、待つ間に再描画が走っても困らないよう、クリック・キーの時点で記録する
// viewerGen は開く操作のたびに増やす（openReport が fetch の後に、自分より後の操作があったかを見るため）
let viewerOpener = null, viewerGen = 0;
// モーダルの中身。元のテキストは <pre id="vbody">、レポートの Markdown プレビューは <div id="vmd"> に入れ、見せるほうだけ hidden を外す。
// 判定・エラー・レポートの取得失敗は Markdown ではないので元のテキストだけ（isReport が偽）。そのときは切替ボタンも出さない
// isReportRaw はユーザーが選んだ表示。モーダルを閉じても、別のレポートを開いても保つ（プレビューが崩れるレポートを続けて元のテキストで読めるように）
let isReportRaw = false, hasPreview = false;
function fillViewer(text, fontSize, isReport){
  const body = document.getElementById('vbody'), md = document.getElementById('vmd');
  body.textContent = text; body.scrollTop = 0; body.style.fontSize = fontSize;
  let html = null;
  if (isReport) try { html = renderMarkdown(text); } catch {} // 変換に失敗しても、元のテキストでは読めるようにする
  hasPreview = html !== null; md.innerHTML = html ?? ''; md.scrollTop = 0;
  showViewerMode();
}
function showViewerMode(){
  const isPreview = hasPreview && !isReportRaw, sw = document.getElementById('vmode');
  document.getElementById('vbody').hidden = isPreview; document.getElementById('vmd').hidden = !isPreview;
  sw.hidden = !hasPreview; // 「プレビュー」「元のテキスト」を並べ、いま出しているほうを aria-pressed で示す（色も aria-pressed で付ける）
  for (const b of sw.querySelectorAll('button[data-mode]')) b.setAttribute('aria-pressed', String((b.dataset.mode === 'raw') === isReportRaw));
}
document.getElementById('vmode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) { isReportRaw = b.dataset.mode === 'raw'; showViewerMode(); } });
function noteOpener(el){ viewerOpener = locate(el); viewerGen++; }
// showModal で背景を操作できなくし（Tab・クリックとも）、フォーカスを中へ移す。開いたまま別の内容に切り替えるときは呼び直さない
function showViewer(){ const v = document.getElementById('viewer'); if (!v.open) v.showModal(); }
function closeViewer(){ const v = document.getElementById('viewer'); if (v.open) v.close(); }
// Esc（dialog 標準）・×・背景のどれで閉じてもここを通る
document.getElementById('viewer').addEventListener('close', () => {
  const o = viewerOpener; viewerOpener = null; if (!o) return;
  const el = o.el.isConnected ? o.el : relocate(o);
  if (el) el.focus();
});
// 背景（モーダルの外側）クリックで閉じる。box 内で文字選択して外で離した場合は閉じない（mousedown も背景のときだけ）
const viewerEl = document.getElementById('viewer'); let viewerDown = null;
viewerEl.addEventListener('mousedown', e => { viewerDown = e.target; });
viewerEl.addEventListener('click', e => { if (e.target === viewerEl && viewerDown === viewerEl) closeViewer(); });
let lastRaw = null, lastMeta = null, MAX = null;
let selectedRun = new URLSearchParams(location.search).get('run') || '';
// いま #app に描いている run。selectRun は描き直す前に selectedRun を変え、取得に失敗すると前の画面が残るので、
// 画面のボタンから開くレポートは selectedRun ではなくこちらの run から取る（押したボタンと別の run のレポートを出さないように）
let shownRun = '';
// ?run= の run が見つからなかったとき true。最新の run に戻した後も、ユーザーが run を選び直すまで #upd に出し続ける
let isRunMissing = false;
// ?demo=1: スクリーンショット用。タスク名・リポジトリ名・ブランチ・Issue 番号を仮の値にし、エージェント出力とキューは出さない
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
function demoize(st){
  if (st.active) {
    st.repo = 'my-repo'; st.active.meta.runSlug = 'sample-task';
    if (st.currentTask) Object.assign(st.currentTask, { summary: 'Issue #123: サンプルタスク', name: 'sample-task', branch: 'takt/123-sample-task', issue: 123, raw: '' });
  }
  (st.runs || []).forEach((r, i) => { r.label = (r.label && r.label.startsWith('UI: ') ? 'UI: ' : '') + 'サンプルタスク ' + (i + 1); });
  st.lastOutput = null; st.tasksPath = null;
  return st;
}
let SHOW_ALL = false;
// 選択（run・全件表示）を変えるたびに増やす。応答待ちの間に変わっていたら古い応答を捨てる（A → B → A と戻した場合も区別できるように）
let selGen = 0;
function selectRun(v){
  selGen++;
  viewerGen++; // 切り替え前の run で取得中のレポートが、切り替え後に遅れて届いても開かない
  if (v === '__more__') {
    // 全件に切り替えたあと、閉じてしまったプルダウンを開き直す（showPicker はクリック直後の数秒だけ許される。非対応ブラウザでは何もしない）
    SHOW_ALL = true; lastRaw = null;
    tick().then(() => { try { document.getElementById('runsel').showPicker(); } catch {} });
    return;
  }
  if (v) isRunMissing = false;
  selectedRun = v; lastRaw = null; history.replaceState(null, '', (v ? '?run='+encodeURIComponent(v) : location.pathname) + (DEMO ? (v ? '&' : '?') + 'demo=1' : '')); tick(); }
function statusLabel(s){ return s==='interrupted' ? '中断' : s; }
function runLabel(r){ const mark = r.status==='running' ? '🟢 ' : (r.status==='completed' ? '✅ ' : (r.status==='interrupted' ? '🟠 中断 ' : '🔴 ' + r.status + ' ')); const info = [startAt(r.startTime), r.step].filter(Boolean).join(' '); return mark + (r.label || r.slug.replace(/^\d{8}-\d{6}-/,'')) + (info ? '  (' + info + ')' : ''); }
// 状態を取得できなかったことを #upd に出す。#app は消さず、最後に表示できていた画面を残す。
// lastRaw を捨てるのは、復旧後の応答が失敗前と同じでも描き直して、このエラー表示を消すため
function showStateError(){ lastRaw = null; document.getElementById('upd').innerHTML = '<span class="err">サーバーから取得できません</span>'; }
// 取得が 2 秒を超えると次の tick と重なる。後から始めた取得の結果（成功・失敗とも）を反映した後に届いた、先に始めた取得の結果は捨てる（同じ世代なので selGen では見分けられない）
let tickSeq = 0, shownSeq = 0;
async function tick(){
  const reqRun = selectedRun, gen = selGen, seq = ++tickSeq;
  let raw;
  try {
    const res = await fetch('/api/state?' + (reqRun ? 'run='+encodeURIComponent(reqRun) : '') + (SHOW_ALL ? '&all=1' : ''));
    if (!res.ok) throw new Error('HTTP ' + res.status); // 500 の本文は internal error で JSON ではない
    raw = await res.text();
  } catch { if (gen === selGen && seq > shownSeq) { shownSeq = seq; showStateError(); } return; } // 古い世代の失敗・後から始めた取得の結果より前の失敗は、その後の表示を上書きしないよう捨てる
  if (gen !== selGen) return; // 応答待ちの間に選択を変えられたら古い応答は捨てる（後から届いて選んだ run の表示や選択を上書きしないように）
  if (reqRun !== selectedRun) return; // 選択が空のまま始めた取得が、自動選択の後に届いたら捨てる（表示と選択中の run が食い違わないように。次の tick で選択中の run を取り直す）
  if (seq < shownSeq) return; // 後から始めた取得の結果（失敗のエラー表示を含む）を、先に始めた取得の古い応答で上書きしない
  shownSeq = seq;
  if (raw === lastRaw) {
    const el = document.getElementById('elapsed');
    if (el && lastMeta && lastMeta.status === 'running') el.textContent = fmt(Date.now() - startMs(lastMeta.startTime));
    return;
  }
  lastRaw = raw;
  let parsed; try { parsed = JSON.parse(raw); } catch { showStateError(); return; }
  const st = DEMO ? demoize(parsed) : parsed;
  // ?run= の run が見つからない: 選択と URL の ?run= を外して最新の run を取り直す
  if (st.runNotFound) { isRunMissing = true; selectRun(''); return; }
  const a = st.active;
  lastMeta = a ? a.meta : null;
  const sel = document.getElementById('runsel');
  const cur = a ? a.runDir : '';
  // 一覧は新しい 20 件。残りがあるときは末尾に「もっと見る」を置き、選ぶと全件に切り替える
  const more = (!SHOW_ALL && st.runsTotal > (st.runs||[]).length) ? '<option value="__more__">… もっと見る（残り '+(st.runsTotal - st.runs.length)+' 件）</option>' : '';
  sel.innerHTML = (st.runs||[]).map(r => '<option value="'+escA(r.runDir)+'"'+(r.runDir===cur?' selected':'')+'>'+esc(runLabel(r))+'</option>').join('') + more;
  if (!selectedRun && cur) selectedRun = cur; // 自動選択を固定（他の run が更新されても切り替わらない）
  // 再描画前にスクロール位置を保存（末尾に張り付いていたら再描画後も末尾へ）
  const keep = {};
  for (const el of document.querySelectorAll('.scroll')) keep[el.id] = { top: el.scrollTop, left: el.scrollLeft, atBottom: el.scrollHeight - el.clientHeight - el.scrollTop < 4, atRight: el.scrollWidth - el.clientWidth - el.scrollLeft < 4 };
  const winY = window.scrollY;
  // Tab で #app の中の要素に移っていたら、作り直した後も同じ位置の要素へフォーカスを戻す（戻さないと body に落ち、Tab を最初からやり直すことになる）
  const fa = document.activeElement; const focusInApp = fa && document.getElementById('app').contains(fa) ? locate(fa) : null;
  const notFoundMsg = isRunMissing ? '<span class="err">指定した run が見つかりません</span> ' : '';
  // run が無いときも #upd を書き直す（isRunMissing でなくても。取得失敗のエラー表示を残さないため）
  if (!a) { document.getElementById('upd').innerHTML = notFoundMsg; document.getElementById('app').innerHTML = '<section class="wide">takt の run が見つかりません</section>'; shownRun = ''; return; }
  const m = a.meta;
  MAX = a.maxSteps ?? null;
  document.getElementById('upd').innerHTML = notFoundMsg + esc('最終更新 ' + jst(m.updatedAt));
  const end = m.status==='running' ? Date.now() : new Date(m.updatedAt).getTime();
  const stack = (m.resume_point?.stack ?? []).map((s,i,arr) => (i===arr.length-1 ? '<b>'+esc(s.workflow)+' › '+esc(s.step)+'</b>' : esc(s.workflow)+' › '+esc(s.step))).join(' &nbsp;→&nbsp; ');
  const tl = st.timeline;
  TL = tl;
  // 一番新しい行に印を付ける（木にすると最新の行が表の途中に出るため）
  LATEST = tl.reduce((best, r, i) => (best < 0 || r.ts > tl[best].ts) ? i : best, -1);
  // completed の run は、最後の判定（maintenance なら final-gate の APPROVE など）をバッジの横に出す。判定が無ければ出さない
  const judgedAt = (r) => r.judge.ts || r.ts;
  const finalIdx = m.status==='completed' ? tl.reduce((best, r, i) => (r.judge && r.judge.label && (best < 0 || judgedAt(r) >= judgedAt(tl[best]))) ? i : best, -1) : -1;
  const pct = MAX ? Math.min(100, Math.round((m.currentIteration ?? 0) / MAX * 100)) : 0;
  document.getElementById('app').innerHTML = `
    <section class="c2 toprow" style="height:${TL_H}px">
      <h2>タスク</h2>
      <div class="big">${esc(st.currentTask ? (st.currentTask.summary || st.currentTask.name) : m.runSlug.replace(/^\d{8}-\d{6}-/,''))}</div>
      <div class="row"><span class="k">リポジトリ</span><span>${esc(st.repo)}</span></div>
      ${st.currentTask && st.currentTask.issue ? '<div class="row"><span class="k">Issue</span><span>#'+esc(String(st.currentTask.issue))+'</span></div>' : ''}
      ${st.currentTask && st.currentTask.branch ? '<div class="row"><span class="k">ブランチ</span><span>'+esc(st.currentTask.branch)+'</span></div>' : ''}
      <div style="margin:8px 0"><span class="badge b-${escA(m.status)}">${esc(statusLabel(m.status))}</span>${finalIdx >= 0 ? ' '+judgeLink(tl[finalIdx], finalIdx) : ''}</div>
      <div class="row"><span class="k">ワークフロー</span><span>${esc(m.workflow)}</span></div>
      <div class="row"><span class="k">イテレーション</span><span>${esc(m.currentIteration)} / ${MAX ?? '?'}</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      ${startAt(m.startTime, true) ? '<div class="row" style="margin-top:8px"><span class="k">開始</span><span>'+startAt(m.startTime, true)+'</span></div><div class="row"><span class="k">経過時間</span><span id="elapsed">'+fmt(end - startMs(m.startTime))+'</span></div>' : ''}
      ${(m.resume_point?.stack ?? []).length > 1 ? '<div class="stack">'+stack+'</div>' : ''}
      ${a.reports.length ? '<h2 style="margin-top:14px">未分類のレポート</h2><div id="reps" class="scroll" style="overflow:auto;max-height:160px">'+a.reports.slice().reverse().map(r => '<div class="row"><button type="button" class="rep" data-rel="'+escA(r.rel)+'">'+esc(r.rel)+'</button><span class="k">'+r.size+' B</span></div>').join('')+'</div>' : ''}
    </section>
    <section class="c4 toprow" style="height:${TL_H}px">
      <h2>タイムライン</h2>
      <div id="tl" class="scroll" style="overflow:auto;height:${TL_H - 62}px"><table>${tl.map(rowHtml).join('')}</table></div>
    </section>

    <section class="wide pathsec">
      <div class="rz" id="tlrz" tabindex="0" role="separator" aria-orientation="horizontal" aria-label="上段（タスク・タイムライン）の高さ" aria-valuemin="${TL_H_MIN}" aria-valuemax="${TL_H_MAX}" aria-valuenow="${TL_H}" aria-valuetext="${TL_H}px" title="ドラッグか ↓ / ↑ キーで上段（タスク・タイムライン）の高さを変更。ダブルクリックか Enter で既定に戻す"></div>
      <h2>実行経路</h2>
      <div id="path" class="scroll path">${pathHtml(pathModel(tl, m))}</div>
    </section>

    ${DEMO ? '' : `<section class="c3">
      <h2>最新のエージェント出力${st.lastOutput ? ' — '+esc(st.lastOutput.step)+' ('+jst(st.lastOutput.ts)+')' : ''}</h2>
      <pre id="out" class="scroll">${esc(st.lastOutput ? st.lastOutput.content.split('\n').slice(-60).join('\n') : '(まだありません)')}</pre>
    </section>
    <section class="c3">
      <h2>タスクキュー${st.tasksPath ? ' — '+esc(st.tasksPath) : ''}</h2>
      <pre id="tasks" class="scroll" style="max-height:none">${esc(st.currentTask ? st.currentTask.raw : '(この run に対応するキューはありません)')}</pre>
    </section>`}`;
  shownRun = cur;
  restoreScroll(keep, winY);
  drawEdges();
  if (focusInApp) { const el = relocate(focusInApp); if (el) el.focus({ preventScroll: true }); } // スクロール位置は restoreScroll で戻したので動かさない
}
function restoreScroll(keep, winY){
  for (const el of document.querySelectorAll('.scroll')) {
    const k = keep[el.id];
    // 初回描画: タイムラインは末尾、経路は右端（最新のステップが見える位置）。以後は末尾/右端に張り付いていたら追従、そうでなければ位置を保つ
    if (!k) { if (el.id === 'tl') el.scrollTop = el.scrollHeight; if (el.id === 'path') el.scrollLeft = el.scrollWidth; continue; }
    el.scrollTop = (k.atBottom && el.id === 'tl') ? el.scrollHeight : k.top;
    if (el.id === 'path') el.scrollLeft = k.atRight ? el.scrollWidth : k.left;
  }
  window.scrollTo(0, winY);
}
tick(); setInterval(tick, 2000);

# takt-dashboard

[TAKT](https://github.com/nrslib/takt) の run をブラウザで見張るローカル Web ダッシュボード。
ユーザー向けの説明・使い方は README.md を正とする。ここには開発時に守ることだけ書く。

## 構成

| パス | 内容 |
|---|---|
| `bin/takt-dashboard` | 本体。サーバー（Node.js）とブラウザ側（`HTML` 定数に埋め込んだ HTML/CSS/JS）が 1 ファイルに入っている。拡張子なし・ESM |
| `test/*.test.js` | `node:test` のテスト。`bin/takt-dashboard` を子プロセスで起動し、HTTP 応答と終了コードで確認する |
| `docs/` | README 用のスクリーンショットのみ |
| `.coderabbit.yaml` | CodeRabbit の設定（日本語・assertive・draft PR もレビュー） |

`bin/takt-dashboard` の中は `// ---------- 見出し ----------` でセクション分けされている（設定 / run 探索 / 中断判定 / routing / タイムライン / レポート / tasks.yaml / state / HTML / サーバー）。コードを足すときは該当セクションに入れる。

## 前提

**このダッシュボードは公開して配布するソフトウェアであり、作者の環境専用ではない。** 設計・実装・テストのすべてで、作者とは異なる環境のユーザーを前提に考える。

- ユーザーの環境は作者と違う。takt のバージョン・設定（`~/.takt/runtime.yaml` / `config.yaml` の有無や内容）・ディレクトリ構成・OS・リポジトリの置き方・run の数や状態（失敗・中断・ログ欠損）は、作者の手元と同じとは限らない
- 作者の手元で動いたことを「正しい」の根拠にしない。想定どおりの入力だけでなく、設定ファイルが無い・形式が少し違う・run が壊れている場合も落ちずに動くことを確認する
- 作者の手元のパス・リポジトリ名・設定値をコードや既定値に埋め込まない。環境依存の値はコマンドライン / 環境変数 / 設定ファイルから受け取る
- README は初見のユーザーが読む前提で書く。作者だけが知っている前提や経緯を省略しない

## 設計方針（変えない）

- **依存ライブラリなし。** Node.js 標準ライブラリだけで動かす（`package.json` に dependencies を足さない）。yaml（`config.yaml` / `runtime.yaml` / `tasks.yaml`）も自前の簡易パースで読む
- **1 ファイル。** サーバーもブラウザ側のコードも `bin/takt-dashboard` に置く。分割しない
- **読むだけ。** takt 本体の `~/.takt/` には書き込まない。ダッシュボード自身のデータは `~/.config/takt-dashboard/` に置く
- **ローカル専用。** `127.0.0.1` にだけ bind する。認証はない
- **run 開始時点の設定を使う。** 並列の子の provider / model は run ごとに `routing/<run slug>.json` に保存し、以後 yaml を変えても過去の表示を変えない
- **`?run=` で指定した run が無いときに別の run へフォールバックしない。** `runNotFound` を返し、URL と表示を食い違わせない
- ハンドラ内の例外でプロセスを落とさない（500 を返す）

## 開発

```bash
npm link                 # takt-dashboard コマンドが clone 先を指す
node --test test/*.test.js
```

- `engines.node >= 20`。`node:test` を使うので別のテストランナーは入れない
- テストは実環境の `~/.takt` / `~/.config/takt-dashboard` を読まないよう、`HOME` と cwd を一時ディレクトリにして起動する（`test/takt-dashboard.test.js` の `makeSandbox` / `spawnDashboard` を使う）
- run ディレクトリの体裁: `<root>/.takt/runs/<slug>/` に `meta.json`・`logs/*.jsonl`・`reports/*.md`。テストで run を作るときもこの形にする
- 対応している takt のログ形式は **0.73.0** で確認したもの。takt 側の形式は実験的機能で予告なく変わる。形式に依存する箇所を直したときは README の「注意」のバージョンも見直す

## コードの書き方

- コメント・テスト名・コミットメッセージ・UI 文言は日本語
- コメントには「何をするか」ではなく「なぜそうするか」（takt のどの挙動に合わせたか等）を書く。既存の書き方に揃える
- boolean は `is` / `has` 始まりの肯定形（例: `isRunMissing`）
- ブラウザ側の HTML はテンプレートリテラル内なので、`${}` とバッククォートのエスケープに注意する

## README

- 日本語と英語（`## English` 以下）の 2 部構成。挙動・オプション・設定ファイルを変えたら**両方**を更新する
- 画面の文言を README や Issue / PR に書くときは、`bin/takt-dashboard` の実際の文言を確認してから書く

## コミット・PR

- コミットメッセージは `fix:` / `feat:` / `docs:` / `chore:` + 日本語の説明。1 行目だけで「何を・なぜ」が分かるようにする（例: `fix: 127.0.0.1 にだけ bind する（README の「ローカル専用」の記述どおりに）`）
- `main` への直接 push はしない。PR を経由する
- PR は CodeRabbit（assertive）がレビューする。指摘には対応するか、対応しない理由を返す

// ESLint は検査だけに使う（整形はしない。既存の 1 行に詰めた書き方はそのまま）
// 実行: npm run lint
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }], // `try { … } catch {}` は「失敗は無視」の意図で多用している
      'no-regex-spaces': 'off', // YAML のインデントを /^  key:/ のように字面どおり書いている。{2} にすると読みにくい
      'no-unused-vars': ['error', { ignoreRestSiblings: true }], // `const { owner_pid, ...rest } = task` のように、応答から外す項目を分割代入で捨てる書き方を許す
    },
  },
  {
    // サーバー（拡張子なし）とテスト。ESM で Node.js のグローバルを使う
    files: ['bin/takt-dashboard', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
  {
    // ブラウザ側。index.html の onclick から呼ぶ関数があるので、グローバルな script として読む
    files: ['bin/ui/app.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.browser },
  },
];

# ルール説明動画（ナレーション付き）

最初に流す説明動画 `assets/rules-intro.webm`（1920×1080・30fps・VP9＋Opus）を作るツールです。
投影画面（`apps/web/display.css`）と同じ赤・墨黒・生成りの配色とフォントで、テロップ・効果音・ナレーションを入れます。BGMはありません。

## 作り方

Node.js 20以上と Microsoft Edge が必要です。初回だけこのフォルダーで `npm install` を実行します。

```powershell
cd tools/intro-video
npm install
node render.mjs                 # VOICEVOX の春日部つむぎで作る（VOICEVOXを起動しておく）
```

- 台本・テロップ・効果音のタイミングは `script.js`、絵と動きは `scenes.js` にあります。
- シーンの長さはナレーションの長さに合わせて自動で決まります。
- `node render.mjs --preview` で表示されるURLをブラウザーで開くと、書き出さずに音付きで確認できます。
- `node render.mjs --stills 5,30,60` で、指定秒の静止画一覧を `build/stills/` に出力します。

## 声を変える

1. https://voicevox.hiroshiba.jp/ から VOICEVOX をインストールして起動します。
2. 標準は春日部つむぎ（スタイルID 8）です。別のキャラクターにするときはスタイルIDを指定します（例：ずんだもん ノーマル＝3、四国めたん ノーマル＝2）。VOICEVOXを使わない場合は `--voice haruka` でWindows標準の声になります。

```powershell
node render.mjs --voice voicevox --speaker 3
```

`--speed 1.15` で話す速さを変えられます。VOICEVOXの規約に従い、動画右下に「VOICEVOX:キャラクター名」を自動で表示します。キャラクターごとの利用規約も確認してください。

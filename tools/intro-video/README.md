# ルール説明動画（ナレーション付き）

最初に流す説明動画 `assets/rules-intro.webm`（1920×1080・30fps・VP9＋Opus）を作るツールです。
投影画面（`apps/web/display.css`）と同じ赤・墨黒・生成りの配色とフォントで、テロップ・効果音・ナレーションを入れます。BGMはありません。

## 作り方

Node.js 20以上と Microsoft Edge が必要です。初回だけこのフォルダーで `npm install` を実行します。

```powershell
cd tools/intro-video
npm install
node render.mjs                 # Windows標準の音声「Haruka」で作る（仮）
```

- 台本・テロップ・効果音のタイミングは `script.js`、絵と動きは `scenes.js` にあります。
- シーンの長さはナレーションの長さに合わせて自動で決まります。
- `node render.mjs --preview` で表示されるURLをブラウザーで開くと、書き出さずに音付きで確認できます。
- `node render.mjs --stills 5,30,60` で、指定秒の静止画一覧を `build/stills/` に出力します。

## 声を VOICEVOX に差し替える

1. https://voicevox.hiroshiba.jp/ から VOICEVOX をインストールして起動します。
2. 使うキャラクターのスタイルIDを指定して書き出します（例：ずんだもん ノーマル＝3、四国めたん ノーマル＝2）。

```powershell
node render.mjs --voice voicevox --speaker 3
```

`--speed 1.15` で話す速さを変えられます。VOICEVOXの規約に従い、動画右下に「VOICEVOX:キャラクター名」を自動で表示します。キャラクターごとの利用規約も確認してください。

## 実写映像への差し替え

「02 ゲームの流れ」のシーン（`script.js` で `placeholder: true`）は仮の図解です。画面右下に「PLACEHOLDER 実写映像に差し替え予定」と表示しています。

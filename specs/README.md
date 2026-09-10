# ハードウェアとソフトウェアの境界仕様

`hardware-profile.json` はファームウェアとPCサーバーが共通で参照する現行構成です。GPIOを変更した場合は `node tools/generate-firmware-profile.mjs` を実行し、自動テストを通してください。

`component-plan.csv` は部品候補と変更点の一覧であり、確定済みの発注用BOMではありません。回路担当者が電気定格と実装条件を確認して確定します。


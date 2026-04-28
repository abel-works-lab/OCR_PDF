# OCR Page Capture

PDFや帳票のスクリーンショットをキャプチャし、GeminiにOCR変換させてスプレッドシートに貼り付けるChrome拡張機能。

## 機能

- **手動キャプチャ**: 現在のタブをワンクリックでキャプチャ（ショートカット: `Ctrl+Shift+S`）
- **自動連続キャプチャ**: ページ番号を指定して複数ページを自動スクロール＆キャプチャ
- **Geminiへ送信**: キャプチャした画像をGeminiに自動注入
- **ズーム維持**: キャプチャ時にユーザーが設定した表示倍率を維持
- **送信済み管理**: 送信済み画像に ✓ バッジを表示

## 使い方

1. `chrome://extensions/` を開き、デベロッパーモードをON
2. 「パッケージ化されていない拡張機能を読み込む」で `chrome-extension/` フォルダを選択
3. PDFや帳票をChromeで開く
4. 拡張機能アイコンをクリックしてサイドパネルを開く
5. ページ番号を入力して「オートキャプチャ」、またはショートカットキーで手動キャプチャ
6. 「Geminiに送る」ボタンで画像をGeminiへ送信

## Gemini Gem との連携

本拡張機能は Gemini Gem（カスタムAI）と組み合わせて使用します。  
Gem に画像を送ると、ドキュメント構造をHTMLで再現しスプレッドシート用にTSVコピーできます。

## ファイル構成

```
chrome-extension/
├── manifest.json       # 拡張機能の設定
├── background.js       # Service Worker（キャプチャ・Gemini注入）
├── sidepanel.html      # サイドパネルUI
├── sidepanel.js        # サイドパネルのロジック
├── sidepanel.css       # スタイル
└── gemini_content.js   # Geminiページ用コンテンツスクリプト
```

## 対応ページ

- 一般Webページ
- ChromeネイティブPDFビューア（`.pdf` URL）
- Google ドライブ PDF（`docs.google.com`）

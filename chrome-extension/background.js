// IMAGE_CAP_SYNC: sidepanel.js の IMAGE_CAP と必ず同じ値にすること
const IMAGE_CAP = 50;
// A4縦 96dpi 相当（汎用ページのページ高さ推定値）
const A4_HEIGHT_PX = 1123;
const DB_NAME = "ocr-capture-db";
const STORE_NAME = "images";
const DB_VERSION = 1;
const KEEPALIVE_ALARM = "sw-keepalive";
let _lastCaptureTime = 0;
let _scrollCaptureAborted = false;

// ---- IndexedDB ----

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getImages() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = (e) => {
        const rows = e.target.result;
        rows.sort((a, b) => a.timestamp - b.timestamp);
        resolve(rows);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (e) {
    console.error("[OCR BG] getImages 失敗:", e);
    return [];
  }
}

async function saveImages(images) {
  try {
    const capped = images.length > IMAGE_CAP ? images.slice(-IMAGE_CAP) : images;
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const img of capped) store.put(img);
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
    notifySidePanel(capped);
  } catch (e) {
    console.error("[OCR BG] saveImages 失敗:", e);
    throw new Error(`画像保存失敗: ${e.message}`);
  }
}

// ---- Service Worker keepalive ----

// MV3 の SW はアイドル30秒で停止するため 25秒ごとに alarm で起こす
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) { /* SW を生かし続けるだけ */ }
});

// ---- ユーティリティ ----

// captureVisibleTab のレート制限ラッパー（1秒2回上限対策）
async function captureVisibleTabSafe(windowId, options) {
  const now = Date.now();
  const wait = 500 - (now - _lastCaptureTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCaptureTime = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, options);
}

// サイドパネルに更新を通知（images を一緒に送ることで GET_IMAGES の往復を省く）
function notifySidePanel(images) {
  chrome.runtime.sendMessage({ type: "IMAGE_UPDATED", images }).catch(() => {});
}

// スクロールキャプチャの進捗をサイドパネルに通知
function notifyProgress(current, total) {
  chrome.runtime.sendMessage({ type: "SCROLL_PROGRESS", current, total }).catch(() => {});
}

// ---- リンクラベル焼き込み ----

// OffscreenCanvas でリンク位置に L0〜Ln ラベルを焼き込む
// （Gemini へのリンク参照精度向上用。呼び出し側で links = [{id, bbox:{x,y}}] を渡す）
async function drawLabeledLinks(dataUrl, links, zoom = 1, devicePixelRatio = 1) {
  const scale = devicePixelRatio * zoom;
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  ctx.font = "bold 13px monospace";
  ctx.textBaseline = "top";
  for (const link of links) {
    const { id, bbox } = link;
    if (!bbox) continue;
    const x = bbox.x * scale;
    const y = bbox.y * scale;
    const label = `L${id}`;
    const metrics = ctx.measureText(label);
    ctx.fillStyle = "yellow";
    ctx.fillRect(x, y, metrics.width + 4, 17);
    ctx.fillStyle = "red";
    ctx.fillText(label, x + 2, y + 1);
  }
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(outBlob);
  });
}

// ---- 手動キャプチャ ----

async function captureCurrentTab(label) {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: "アクティブタブが見つかりません" };

  const dataUrl = await captureVisibleTabSafe(tab.windowId, { format: "jpeg", quality: 95 });
  const images = await getImages();
  images.push({
    id: crypto.randomUUID(),
    dataUrl,
    label: label || `capture-${Date.now()}`,
    timestamp: Date.now(),
  });
  await saveImages(images);
  return { success: true };
}

// ---- ページ番号指定キャプチャ（PDF向け） ----

async function scrollAndCapture(tabId, pageNumbers, delay = 1500) {
  const targetTab    = await chrome.tabs.get(tabId);
  const windowId     = targetTab.windowId;
  const originalZoom = await chrome.tabs.getZoom(tabId);
  const existing     = await getImages();
  const newItems     = [];

  for (const pageNum of pageNumbers) {
    await scrollToPage(tabId, pageNum, delay);
    // ズームをリトライ付きで確実に復元（PDF描画後の非同期リセット対策）
    for (let attempt = 0; attempt < 3; attempt++) {
      await chrome.tabs.setZoom(tabId, originalZoom);
      await new Promise(r => setTimeout(r, 200));
      const currentZoom = await chrome.tabs.getZoom(tabId);
      if (Math.abs(currentZoom - originalZoom) < 0.01) break;
    }
    // PDFビューアはcomplete後も描画が続くため追加待機
    await new Promise(r => setTimeout(r, 400));
    const dataUrl = await captureVisibleTabSafe(windowId, { format: "jpeg", quality: 95 });
    newItems.push({
      id: crypto.randomUUID(),
      dataUrl,
      label: `page-${pageNum}`,
      timestamp: Date.now(),
    });
    // 1枚ごとにUIへ反映（進捗表示のため毎回保存）
    await saveImages([...existing, ...newItems]);
  }
  return { success: true };
}

// ページ種別を判定してスクロール
async function scrollToPage(tabId, pageNum, delay = 1500) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";

  const isPdfUrl = /\.pdf($|[?#])/i.test(url);
  const isGdrive = url.includes("docs.google.com");

  if (isPdfUrl || isGdrive) {
    const baseUrl = url.split("?")[0].split("#")[0];
    const targetQuery = `_p=${pageNum}`;
    const loaded = new Promise(resolve => {
      let urlSeen = false;
      const fn = (id, info) => {
        if (id !== tabId) return;
        if (info.url && info.url.includes(targetQuery)) urlSeen = true;
        if (urlSeen && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(fn);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(fn);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, 15000);
    });
    await chrome.tabs.update(tabId, { url: `${baseUrl}?_p=${pageNum}#page=${pageNum}` });
    await loaded;
    await new Promise(r => setTimeout(r, delay));
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (n, a4H) => {
      const page = document.querySelector(`.page[data-page-number="${n}"]`);
      if (page) { page.scrollIntoView({ behavior: "instant" }); return; }
      const el = document.querySelector("#numPages, .page-count");
      const totalPages = el ? (el.textContent.match(/\d+/) || [])[0] : null;
      if (totalPages) {
        window.scrollTo({ top: document.body.scrollHeight * (n - 1) / parseInt(totalPages, 10), behavior: "instant" });
      } else {
        window.scrollTo({ top: (n - 1) * a4H, behavior: "instant" });
      }
    },
    args: [pageNum, A4_HEIGHT_PX],
  });
}

// ---- 全体スクロールキャプチャ（Note・ブログ等） ----

async function startScrollCapture(tabId, windowId, mainOnlyMode = false) {
  _scrollCaptureAborted = false;

  const [dimResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }),
  });
  const { scrollHeight, viewportHeight } = dimResult.result;
  const step = Math.floor(viewportHeight * 0.8);
  const totalSteps = Math.max(1, Math.ceil((scrollHeight - viewportHeight) / step) + 1);

  // fixed/sticky 要素を一時非表示にしてヘッダー・サイドバーの重複を防ぐ
  if (mainOnlyMode) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__ocrHiddenEls = [];
        for (const el of document.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'sticky') && !el.dataset.ocrHidden) {
            el.dataset.ocrHidden = '1';
            el.dataset.ocrOrigDisplay = el.style.display || '';
            el.style.display = 'none';
            window.__ocrHiddenEls.push(el);
          }
        }
      },
    });
  }

  // ページトップにリセット
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo({ top: 0, behavior: "instant" }),
  });
  await new Promise(r => setTimeout(r, 600));

  const existing = await getImages();
  const newItems = [];

  try {
    for (let i = 0; i < totalSteps; i++) {
      if (_scrollCaptureAborted) break;

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (top) => window.scrollTo({ top, behavior: "smooth" }),
        args: [i * step],
      });
      // smooth scroll の完了を待つ
      await new Promise(r => setTimeout(r, 500));

      // lazy load の DOM 安定待機（最大1秒）
      await waitForDomStable(tabId, 400, 1000);

      const dataUrl = await captureVisibleTabSafe(windowId, { format: "jpeg", quality: 95 });
      newItems.push({
        id: crypto.randomUUID(),
        dataUrl,
        label: `scroll-${i + 1}`,
        timestamp: Date.now(),
      });
      await saveImages([...existing, ...newItems]);
      notifyProgress(i + 1, totalSteps);
    }
  } finally {
    // fixed/sticky 要素を元に戻す
    if (mainOnlyMode) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          for (const el of (window.__ocrHiddenEls || [])) {
            el.style.display = el.dataset.ocrOrigDisplay || '';
            delete el.dataset.ocrHidden;
            delete el.dataset.ocrOrigDisplay;
          }
          window.__ocrHiddenEls = [];
        },
      });
    }
  }

  // 全スクショを1枚の長い画像にスティッチ
  if (newItems.length > 1) {
    notifyProgress(newItems.length, newItems.length);
    const stitchedUrl = await stitchImages(newItems.map(img => img.dataUrl)).catch(() => null);
    if (stitchedUrl) {
      const stitchedItem = {
        id: crypto.randomUUID(),
        dataUrl: stitchedUrl,
        label: "scan-complete",
        timestamp: Date.now(),
        isStitched: true,
      };
      await saveImages([...existing, ...newItems, stitchedItem]);
    }
  }

  return { success: true, count: newItems.length };
}

// スクショを縦に並べて1枚の長い画像にスティッチ（コピー機スキャンイメージ）
// stepRatio: スクロール1ステップ = viewport の何割か（0.8 固定）
async function stitchImages(dataUrls, stepRatio = 0.8) {
  if (dataUrls.length === 0) return null;

  // 最初の画像でサイズ取得
  const firstBlob = await fetch(dataUrls[0]).then(r => r.blob());
  const firstBitmap = await createImageBitmap(firstBlob);
  const imgW = firstBitmap.width;
  const imgH = firstBitmap.height;
  const stepPx = Math.floor(imgH * stepRatio);
  const totalH = stepPx * (dataUrls.length - 1) + imgH;

  // キャンバスサイズ上限（Chrome最大 32767px。超える場合は縮小）
  const MAX_H = 32000;
  const scale = totalH > MAX_H ? MAX_H / totalH : 1;
  const canvasW = Math.floor(imgW * scale);
  const canvasH = Math.floor(totalH * scale);

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(firstBitmap, 0, 0, canvasW, Math.floor(imgH * scale));
  firstBitmap.close();

  for (let i = 1; i < dataUrls.length; i++) {
    const blob = await fetch(dataUrls[i]).then(r => r.blob());
    const bm = await createImageBitmap(blob);
    const dy = Math.floor(i * stepPx * scale);
    ctx.drawImage(bm, 0, dy, canvasW, Math.floor(imgH * scale));
    bm.close();
  }

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(outBlob);
  });
}

// DOM の変化が stableMs 間なくなるまで待機（lazy load 対策）
async function waitForDomStable(tabId, stableMs = 400, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [before] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body ? document.body.innerHTML.length : 0,
    });
    await new Promise(r => setTimeout(r, stableMs));
    const [after] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body ? document.body.innerHTML.length : 0,
    });
    if (before.result === after.result) break;
  }
}

// ---- Gemini 注入 ----

// ---- DOM取得（Webページ専用） ----

// ページをスクロールしてlazy loadを発火させ、メインコンテンツのHTMLを抽出する
async function runExtractPageContent(tabId) {
  // トップにリセット
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo({ top: 0, behavior: "instant" }),
  });
  await new Promise(r => setTimeout(r, 400));

  // スクロール高さを取得
  const [dim] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }),
  });
  const { scrollHeight, viewportHeight } = dim.result;
  const step = viewportHeight;
  const totalSteps = Math.ceil(scrollHeight / step);

  // 上から下まで1画面ずつスクロール（lazy loadを全部発火）
  for (let i = 1; i <= totalSteps; i++) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (top) => window.scrollTo({ top, behavior: "smooth" }),
      args: [i * step],
    });
    await new Promise(r => setTimeout(r, 600));
  }
  // トップに戻す
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo({ top: 0, behavior: "instant" }),
  });
  await new Promise(r => setTimeout(r, 300));

  // メインコンテンツを抽出・クリーニング
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const NOISE = [
        'script','style','noscript','iframe','link','meta',
        'nav','header','footer','aside',
        '[class*="sidebar"]','[class*="nav"]','[class*="header"]','[class*="footer"]',
        '[class*="ad"]','[class*="banner"]','[class*="recommend"]','[class*="related"]',
        '[class*="share"]','[class*="social"]','[class*="comment"]','[class*="cookie"]',
        '[class*="popup"]','[class*="modal"]','[role="navigation"]','[role="banner"]',
        '[role="complementary"]','[role="dialog"]',
      ];
      const KEEP_ATTRS = new Set(['href','src','alt','colspan','rowspan']);

      // メインコンテンツエリアを特定（article > main > body の優先順）
      const main =
        document.querySelector('article') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('main') ||
        document.querySelector('#content, #main-content, .article-body, .post-body, .entry-content') ||
        document.body;

      const clone = main.cloneNode(true);

      // ノイズ要素を除去
      for (const sel of NOISE) {
        try { for (const el of clone.querySelectorAll(sel)) el.remove(); } catch {}
      }

      // 属性クリーニング（href/src等だけ残して他は全削除）
      for (const el of clone.querySelectorAll('*')) {
        const drop = [...el.attributes].filter(a => !KEEP_ATTRS.has(a.name)).map(a => a.name);
        for (const a of drop) el.removeAttribute(a);
      }

      const cleanHtml = clone.outerHTML;
      return {
        cleanHtml,
        title: document.title,
        url: location.href,
        charCount: cleanHtml.length,
      };
    },
  });

  return { success: true, ...result.result };
}

// Geminiのテキスト入力エリアにテキストを送る（MAIN world・self-contained）
function geminiInjectText(text) {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function deepQuery(root, finder) {
    const found = finder(root);
    if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const f = deepQuery(el.shadowRoot, finder);
        if (f) return f;
      }
    }
    return null;
  }

  const findTextInput = r => deepQuery(r, root =>
    root.querySelector('rich-textarea') ||
    root.querySelector('[contenteditable="true"]') ||
    root.querySelector('[role="textbox"]')
  );

  return (async () => {
    const input = findTextInput(document);
    if (!input) return { success: false, error: "Geminiのテキスト入力が見つかりません" };

    input.focus();
    await sleep(150);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true, composed: true,
    }));
    await sleep(600);
    return { success: true };
  })();
}

// GeminiページのMAIN worldで実行するファイル注入関数（self-contained）
function geminiInjectMain(dataUrls) {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Shadow DOM を再帰的に探すユーティリティ
  function deepQuery(root, finder) {
    const found = finder(root);
    if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const f = deepQuery(el.shadowRoot, finder);
        if (f) return f;
      }
    }
    return null;
  }

  async function dataUrlToFile(dataUrl, filename) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename, { type: blob.type });
  }

  const findFileInput    = r => deepQuery(r, root => root.querySelector('input[type="file"]'));
  const findTextInput    = r => deepQuery(r, root =>
    root.querySelector('rich-textarea') ||
    root.querySelector('[contenteditable="true"]') ||
    root.querySelector('[role="textbox"]')
  );
  const findUploadButton = r => {
    const keywords = ['アップロード', 'ファイルを追加', 'Upload file', 'Add file', 'Attach'];
    const attrs    = ['aria-label', 'title', 'data-tooltip'];
    return deepQuery(r, root => {
      for (const btn of root.querySelectorAll('button, [role="button"]')) {
        for (const attr of attrs) {
          if (keywords.some(k => (btn.getAttribute(attr) || '').includes(k))) return btn;
        }
      }
      return null;
    });
  };
  const findMenuItemDeep = r => deepQuery(r, root => {
    for (const el of root.querySelectorAll('[role="menuitem"],[role="option"],li')) {
      const t = el.textContent?.trim() ?? '';
      if (t.includes('デバイス') || t.includes('コンピュータ') || t.includes('アップロード')) return el;
    }
    return null;
  });

  function waitFor(timeoutMs, checkFn) {
    return new Promise((resolve, reject) => {
      const found = checkFn();
      if (found) return resolve(found);
      const start = Date.now();
      const interval = setInterval(() => {
        const el = checkFn();
        if (el) { clearInterval(interval); resolve(el); return; }
        if (Date.now() - start >= timeoutMs) { clearInterval(interval); reject(new Error("timeout")); }
      }, 50);
    });
  }

  return (async () => {
    // 二重実行ガード
    if (window['__geminiInjecting']) {
      return { success: false, error: "前回の注入がまだ実行中です" };
    }
    window['__geminiInjecting'] = true;

    try {
      const files = await Promise.all(dataUrls.map((u, i) => dataUrlToFile(u, `capture-${i + 1}.jpg`)));
      console.log("[OCR MAIN] 注入開始, 枚数:", files.length);

      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);

      // ① pasteイベントで直接注入
      const textInput = findTextInput(document);
      console.log("[OCR MAIN] テキスト入力エリア:", textInput?.tagName || textInput?.localName);
      if (textInput) {
        textInput.focus();
        await sleep(100);
        textInput.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true, composed: true,
        }));
        await sleep(800);
        console.log("[OCR MAIN] 注入完了（paste経由）");
        return { success: true };
      }

      // ② DOM上に既にfile inputがある場合は直接注入
      const existingInput = findFileInput(document);
      console.log("[OCR MAIN] 初期file input:", existingInput);
      if (existingInput) {
        existingInput.files = dt.files;
        existingInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        existingInput.dispatchEvent(new Event("input",  { bubbles: true, composed: true }));
        await sleep(500);
        console.log("[OCR MAIN] 注入完了（既存input）");
        return { success: true };
      }

      // ③ prototype.click / showPicker をフックしてインターセプト
      let intercepted = false;
      const originalClick      = HTMLInputElement.prototype.click;
      const originalShowPicker = HTMLInputElement.prototype.showPicker;

      function injectIntoInput(input) {
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("input",  { bubbles: true, composed: true }));
      }
      function restoreHook() {
        HTMLInputElement.prototype.click = originalClick;
        if (originalShowPicker) HTMLInputElement.prototype.showPicker = originalShowPicker;
      }
      HTMLInputElement.prototype.click = function() {
        if (this.type === 'file') {
          console.log("[OCR MAIN] file input.click() をインターセプト");
          injectIntoInput(this); intercepted = true; restoreHook(); return;
        }
        return originalClick.call(this);
      };
      if (originalShowPicker) {
        HTMLInputElement.prototype.showPicker = function() {
          if (this.type === 'file') {
            console.log("[OCR MAIN] file input.showPicker() をインターセプト");
            injectIntoInput(this); intercepted = true; restoreHook(); return;
          }
          return originalShowPicker.call(this);
        };
      }

      try {
        const btn = findUploadButton(document);
        console.log("[OCR MAIN] アップロードボタン:", btn?.getAttribute('aria-label'));
        if (!btn) return { success: false, error: "アップロードボタンが見つかりません" };

        btn.click();
        await sleep(600);

        const menuItem = await waitFor(2000, () => findMenuItemDeep(document)).catch(() => null);
        console.log("[OCR MAIN] メニュー項目:", menuItem?.textContent?.trim());
        if (menuItem) { menuItem.click(); }

        await waitFor(3000, () => intercepted || findFileInput(document)).catch(() => null);

        if (!intercepted) {
          const lateInput = findFileInput(document);
          if (lateInput) { injectIntoInput(lateInput); await sleep(500); return { success: true }; }
          return { success: false, error: "注入できませんでした。Geminiページを開いているか確認してください" };
        }
      } finally {
        restoreHook();
      }

      await sleep(500);
      console.log("[OCR MAIN] 注入完了（フック経由）");
      return { success: true };
    } finally {
      window['__geminiInjecting'] = false;
    }
  })();
}

// 最適なGeminiタブを選ぶ
async function pickGeminiTab() {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (tabs.length === 0) return null;
  if (tabs.length === 1) return tabs[0];

  const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const sameWin     = lastFocused ? tabs.filter(t => t.windowId === lastFocused.id) : [];
  const candidates  = sameWin.length > 0 ? sameWin : tabs;
  return candidates.sort((a, b) =>
    (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
    (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
  )[0];
}

// Gemini 1メッセージあたりの添付上限
const GEMINI_IMAGE_CAP = 10;

// Geminiタブにworld:"MAIN"でスクリプトを直接実行して注入
async function injectToGemini() {
  console.log("[OCR BG] injectToGemini 開始");

  const images = await getImages();
  const unsent  = images.filter(img => !img.sentAt);
  console.log("[OCR BG] 画像数:", images.length, "/ 未送信:", unsent.length);
  if (images.length === 0) return { success: false, error: "バッファに画像がありません" };
  if (unsent.length  === 0) return { success: false, error: "未送信の画像がありません（全て送信済み）" };

  // Geminiの上限（10枚）を超える場合は先頭10枚だけ送る
  const batch     = unsent.slice(0, GEMINI_IMAGE_CAP);
  const remaining = unsent.length - batch.length;

  const tab = await pickGeminiTab();
  if (!tab) return { success: false, error: "Geminiのタブが見つかりません" };
  console.log("[OCR BG] 選択タブ:", tab.url, "/ 今回送信:", batch.length, "/ 残り:", remaining);

  let result;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: geminiInjectMain,
      args: [batch.map(img => img.dataUrl)],
    });
    result = results[0]?.result ?? { success: false, error: "実行結果が取得できませんでした" };
  } catch (e) {
    console.error("[OCR BG] executeScript エラー:", e);
    return { success: false, error: e.message };
  }

  if (result.success) {
    const now      = Date.now();
    const batchIds = new Set(batch.map(img => img.id));
    const updated  = images.map(img => batchIds.has(img.id) ? { ...img, sentAt: now } : img);
    await saveImages(updated);
  }

  return { ...result, sent: batch.length, remaining };
}

// ---- イベントリスナー ----

// ショートカットキー
chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-page") captureCurrentTab();
});

// インストール時にサイドパネルの動作を設定
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// サイドパネルからのメッセージ
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[OCR BG] メッセージ受信:", msg.type);
  (async () => {
    try {
      if (msg.type === "CAPTURE") {
        sendResponse(await captureCurrentTab(msg.label));
      } else if (msg.type === "SCROLL_AND_CAPTURE") {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0]) { sendResponse({ success: false, error: "アクティブタブが見つかりません" }); return; }
        sendResponse(await scrollAndCapture(tabs[0].id, msg.pageNumbers, msg.delay ?? 1500));
      } else if (msg.type === "START_SCROLL_CAPTURE") {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0]) { sendResponse({ success: false, error: "アクティブタブが見つかりません" }); return; }
        const tab = tabs[0];
        sendResponse(await startScrollCapture(tab.id, tab.windowId, msg.mainOnlyMode ?? false));
      } else if (msg.type === "ABORT_SCROLL_CAPTURE") {
        _scrollCaptureAborted = true;
        sendResponse({ success: true });
      } else if (msg.type === "GET_IMAGES") {
        sendResponse({ images: await getImages() });
      } else if (msg.type === "CLEAR_IMAGES") {
        await saveImages([]);
        sendResponse({ success: true });
      } else if (msg.type === "DELETE_IMAGE") {
        const images = await getImages();
        await saveImages(images.filter(img => img.id !== msg.id));
        sendResponse({ success: true });
      } else if (msg.type === "INJECT_TO_GEMINI") {
        sendResponse(await injectToGemini());
      } else if (msg.type === "EXTRACT_DOM") {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0]) { sendResponse({ success: false, error: "アクティブタブが見つかりません" }); return; }
        sendResponse(await runExtractPageContent(tabs[0].id));
      } else if (msg.type === "INJECT_TEXT_TO_GEMINI") {
        const tab = await pickGeminiTab();
        if (!tab) { sendResponse({ success: false, error: "Geminiのタブが見つかりません" }); return; }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: geminiInjectText,
          args: [msg.text],
        });
        sendResponse(results[0]?.result ?? { success: false, error: "実行結果が取得できませんでした" });
      } else {
        sendResponse({ success: false, error: "unknown type" });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

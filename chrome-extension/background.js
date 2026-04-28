// IMAGE_CAP_SYNC: sidepanel.js の IMAGE_CAP と必ず同じ値にすること
const IMAGE_CAP = 50;
// フルページキャプチャ(jpeg quality 85)は1枚2〜5MB。9MBを超えたら古い画像を削る
const MAX_STORAGE_BYTES = 9 * 1024 * 1024;
// A4縦 96dpi 相当（汎用ページのページ高さ推定値）
const A4_HEIGHT_PX = 1123;

async function getImages() {
  const { images = [] } = await chrome.storage.session.get("images");
  return images;
}

async function saveImages(images) {
  // バイト数ベースで古い画像を削る（storage.session の上限は約10MB）
  let total = 0;
  const kept = [];
  for (let i = images.length - 1; i >= 0; i--) {
    const size = images[i].dataUrl.length;
    if (total + size > MAX_STORAGE_BYTES) break;
    total += size;
    kept.unshift(images[i]);
  }
  const capped = kept.length > IMAGE_CAP ? kept.slice(-IMAGE_CAP) : kept;
  try {
    await chrome.storage.session.set({ images: capped });
  } catch (e) {
    throw new Error(`画像保存失敗: ${e.message}`);
  }
  notifySidePanel(capped);
}

// サイドパネルに更新を通知（images を一緒に送ることで GET_IMAGES の往復を省く）
function notifySidePanel(images) {
  chrome.runtime.sendMessage({ type: "IMAGE_UPDATED", images }).catch(() => {});
}

// 現在のアクティブタブをキャプチャしてバッファに追加
async function captureCurrentTab(label) {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: "アクティブタブが見つかりません" };

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
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

// ページ番号リストに従ってスクロール→キャプチャを繰り返す
// URL遷移でズームがリセットされるため、遷移前に保存して毎回復元する
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
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 });
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

// Geminiタブにworld:"MAIN"でスクリプトを直接実行して注入
async function injectToGemini() {
  console.log("[OCR BG] injectToGemini 開始");

  const images = await getImages();
  const unsent  = images.filter(img => !img.sentAt);
  console.log("[OCR BG] 画像数:", images.length, "/ 未送信:", unsent.length);
  if (images.length === 0) return { success: false, error: "バッファに画像がありません" };
  if (unsent.length  === 0) return { success: false, error: "未送信の画像がありません（全て送信済み）" };

  const tab = await pickGeminiTab();
  if (!tab) return { success: false, error: "Geminiのタブが見つかりません" };
  console.log("[OCR BG] 選択タブ:", tab.url);

  let result;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: geminiInjectMain,
      args: [unsent.map(img => img.dataUrl)],
    });
    result = results[0]?.result ?? { success: false, error: "実行結果が取得できませんでした" };
  } catch (e) {
    console.error("[OCR BG] executeScript エラー:", e);
    return { success: false, error: e.message };
  }

  if (result.success) {
    const now       = Date.now();
    const unsentIds = new Set(unsent.map(img => img.id));
    const updated   = images.map(img => unsentIds.has(img.id) ? { ...img, sentAt: now } : img);
    await saveImages(updated);
  }

  return result;
}

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
      } else {
        sendResponse({ success: false, error: "unknown type" });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

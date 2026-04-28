console.log("[OCR Capture] content script loaded");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "INJECT_IMAGES") return false;
  console.log("[OCR Capture] INJECT_IMAGES 受信, 枚数:", msg.dataUrls?.length);
  (async () => {
    try {
      const files = msg.dataUrls.map((u, i) => dataUrlToFile(u, `capture-${i + 1}.jpg`));
      sendResponse(await injectFiles(files));
    } catch (e) {
      console.error("[OCR Capture] エラー:", e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dataUrlToFile(dataUrl, filename) {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

// Shadow DOMを再帰的に探す
function findDeep(root, selector) {
  const el = root.querySelector(selector);
  if (el) return el;
  for (const child of root.querySelectorAll("*")) {
    if (child.shadowRoot) {
      const found = findDeep(child.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

// 要素が出現するまでMutationObserverで待つ
function waitForElement(selectors, timeout = 5000, filter = null) {
  return new Promise((resolve, reject) => {
    const check = () => {
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (!filter || filter(el)) return el;
        }
      }
      return null;
    };
    const found = check();
    if (found) return resolve(found);

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("timeout")); }, timeout);
  });
}

// 「ファイルをアップロード」ボタンをShadow DOM含めて探す
function findAddButton() {
  // aria-label / title どちらでも対応
  const attrs = ['aria-label', 'title', 'data-tooltip'];
  // 「ファイル」単体は会話履歴ボタンと誤ヒットするため「アップロード」で絞る
  const keywords = ['ファイルをアップロード', 'アップロード', 'Upload file', 'Add file'];

  function searchIn(root) {
    for (const btn of root.querySelectorAll('button, [role="button"]')) {
      for (const attr of attrs) {
        const val = btn.getAttribute(attr) || '';
        if (keywords.some(k => val.includes(k))) return btn;
      }
      // テキストでも探す
      const text = btn.textContent?.trim() ?? '';
      if (keywords.some(k => text.includes(k))) return btn;
    }
    // Shadow DOMを再帰的に探す
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = searchIn(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  const btn = searchIn(document);
  if (!btn) {
    // 見つからなかった場合、全ボタンのaria-labelをログ出力（デバッグ用）
    console.warn('[OCR Capture] 添付ボタン見つからず。全ボタン一覧:');
    document.querySelectorAll('button').forEach(b => {
      const label = b.getAttribute('aria-label') || b.title || b.textContent?.trim();
      if (label) console.log(' -', label);
    });
  }
  return btn;
}

async function injectFiles(files) {
  console.log("[OCR Capture] 注入開始, 枚数:", files.length);

  // ① まず隠れているfile inputがないか探す（display:noneも含む全探索）
  function findFileInputAnywhere(root) {
    for (const el of root.querySelectorAll('input[type="file"], input[accept]')) {
      return el; // 可視・不可視問わず最初のものを返す
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = findFileInputAnywhere(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  let fileInput = findFileInputAnywhere(document);
  console.log("[OCR Capture] 初期file input:", fileInput);

  if (!fileInput) {
    // ② 「ファイルを追加」ボタンをクリック（Shadow DOM含む全探索）
    const addBtn = findAddButton();
    console.log("[OCR Capture] 添付ボタン:", addBtn);

    if (!addBtn) {
      return { success: false, error: "「ファイルを追加」ボタンが見つかりません" };
    }

    addBtn.click();
    await sleep(600);

    // ③ メニューが出た場合「デバイスからアップロード」をクリック
    const menuItem = await waitForElement(
      ['[role="menuitem"]', '[role="option"]', "li", "button"],
      2000,
      el => {
        const t = el.textContent?.trim() ?? "";
        return t.includes("デバイス") || t.includes("アップロード") || t.includes("コンピュータ") || t.includes("ファイル");
      }
    ).catch(() => null);

    console.log("[OCR Capture] メニュー項目:", menuItem?.textContent);
    if (menuItem) {
      menuItem.click();
      await sleep(400);
    }

    // ④ file inputが出現するのを待つ（不可視含む）
    fileInput = await waitForElement(['input[type="file"]', 'input[accept]'], 3000).catch(() => null);
    if (!fileInput) fileInput = findFileInputAnywhere(document);
    console.log("[OCR Capture] ボタンクリック後のfile input:", fileInput);
  }

  if (fileInput) {
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(500);
    console.log("[OCR Capture] 注入完了");
    return { success: true };
  }

  return { success: false, error: "file inputが見つかりません。Geminiタブのコンソールを確認してください" };
}

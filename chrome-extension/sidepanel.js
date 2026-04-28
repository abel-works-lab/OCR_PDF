// IMAGE_CAP_SYNC: background.js の IMAGE_CAP と必ず同じ値にすること
const IMAGE_CAP = 50;

const badge = document.getElementById("badge");
const imageGrid = document.getElementById("image-grid");
const pageInput = document.getElementById("page-input");
const statusEl = document.getElementById("status");

let statusTimer = null;

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#e94560" : "#4caf50";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ""), isError ? 10000 : 3000);
}

// 「1,3,5-7」→ [1,3,5,6,7]（合計201枚以上は拒否）
function parsePageNumbers(input) {
  const nums = new Set();
  for (const part of input.split(",")) {
    const range = part.trim();
    if (!range) continue;
    const m = range.match(/^(\d+)-(\d+)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      if (end - start > 200) return [];
      for (let i = start; i <= end; i++) nums.add(i);
    } else if (/^\d+$/.test(range)) {
      nums.add(parseInt(range, 10));
    }
  }
  return [...nums].sort((a, b) => a - b);
}

function renderGrid(images) {
  badge.textContent = images.length;

  while (imageGrid.firstChild) {
    imageGrid.removeChild(imageGrid.firstChild);
  }

  if (images.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-message";
    empty.textContent = "キャプチャ画像なし";
    imageGrid.appendChild(empty);
    return;
  }

  for (const img of images) {
    const card = document.createElement("div");
    card.className = "image-card" + (img.sentAt ? " sent" : "");
    card.dataset.id = img.id;

    const imgEl = document.createElement("img");
    imgEl.src = img.dataUrl;
    imgEl.alt = img.label;
    imgEl.loading = "lazy";

    const labelEl = document.createElement("div");
    labelEl.className = "card-label";
    labelEl.textContent = img.label;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-delete";
    deleteBtn.dataset.id = img.id;
    deleteBtn.title = "削除";
    deleteBtn.setAttribute("aria-label", `${img.label}を削除`);
    deleteBtn.textContent = "×";

    if (img.sentAt) {
      const sentBadge = document.createElement("div");
      sentBadge.className = "sent-badge";
      sentBadge.title = "送信済み";
      sentBadge.textContent = "✓";
      card.appendChild(sentBadge);
    }

    card.appendChild(imgEl);
    card.appendChild(labelEl);
    card.appendChild(deleteBtn);
    imageGrid.appendChild(card);
  }
}

// UI を images 配列で直接更新（loadImages との共通処理）
function updateUI(images) {
  renderGrid(images);
  const btnInject = document.getElementById("btn-inject");
  if (btnInject && !btnInject.disabled) {
    const unsentCount = images.filter(img => !img.sentAt).length;
    btnInject.textContent = unsentCount > 0
      ? `Geminiに送る（${unsentCount}枚）`
      : "Geminiに送る";
  }
}

async function loadImages() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_IMAGES" });
    updateUI(res?.images ?? []);
  } catch {
    // SW（Service Worker）再起動直後は一時的に通信失敗することがある → 無視
  }
}

// 削除ボタンのイベント委譲
imageGrid.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-delete");
  if (!btn) return;
  const id = btn.dataset.id;
  await chrome.runtime.sendMessage({ type: "DELETE_IMAGE", id });
  await loadImages();
});

document.getElementById("btn-capture").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "CAPTURE" });
  if (res?.success) {
    showStatus("キャプチャしました");
    await loadImages();
  } else {
    showStatus(res?.error || "キャプチャ失敗", true);
  }
});

document.getElementById("btn-auto-capture").addEventListener("click", async () => {
  const input = pageInput.value.trim();
  if (!input) {
    showStatus("ページ番号を入力してください", true);
    return;
  }
  const pageNumbers = parsePageNumbers(input);
  if (pageNumbers.length === 0) {
    showStatus("有効なページ番号がありません（範囲は200ページ以内）", true);
    return;
  }

  // 既存バッファ＋新規ページ数が IMAGE_CAP を超えたら警告
  const existingRes = await chrome.runtime.sendMessage({ type: "GET_IMAGES" }).catch(() => ({ images: [] }));
  const existingCount = existingRes?.images?.length ?? 0;
  const totalCount = existingCount + pageNumbers.length;
  if (totalCount > IMAGE_CAP) {
    const dropCount = totalCount - IMAGE_CAP;
    const ok = confirm(
      `現在${existingCount}枚 ＋ 新規${pageNumbers.length}ページ = 計${totalCount}枚になります。\n` +
      `保存上限は${IMAGE_CAP}枚のため、古い${dropCount}枚が自動的に削除されます。\n続けますか？`
    );
    if (!ok) return;
  }

  const btn = document.getElementById("btn-auto-capture");
  btn.disabled = true;
  showStatus(`${pageNumbers.length}ページをキャプチャ中...`);

  const delay = parseInt(document.getElementById("capture-speed").value, 10);
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "SCROLL_AND_CAPTURE",
      pageNumbers,
      delay,
    });
  } catch (e) {
    showStatus(e.message || "通信エラー", true);
    btn.disabled = false;
    return;
  }

  btn.disabled = false;
  if (res?.success) {
    showStatus(`${pageNumbers.length}ページをキャプチャしました`);
    await loadImages();
  } else {
    showStatus(res?.error || "キャプチャ失敗", true);
  }
});

let _extractedHtml = null;

document.getElementById("btn-extract-dom").addEventListener("click", async () => {
  const btn = document.getElementById("btn-extract-dom");
  const resultEl = document.getElementById("dom-result");
  const infoEl = document.getElementById("dom-info");

  btn.disabled = true;
  resultEl.style.display = "none";
  _extractedHtml = null;
  showStatus("ページをスキャン中...");

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "EXTRACT_DOM" });
  } catch (e) {
    showStatus(e.message || "通信エラー", true);
    btn.disabled = false;
    return;
  }

  btn.disabled = false;
  if (res?.success) {
    _extractedHtml = res.cleanHtml;
    const kb = (res.charCount / 1024).toFixed(1);
    infoEl.textContent = `「${res.title}」 ${kb} KB`;
    resultEl.style.display = "";
    showStatus("✓ HTML取得完了");
  } else {
    showStatus(res?.error || "取得失敗", true);
  }
});

document.getElementById("btn-copy-html").addEventListener("click", async () => {
  if (!_extractedHtml) return;
  try {
    await navigator.clipboard.writeText(_extractedHtml);
    showStatus("✓ クリップボードにコピーしました");
  } catch {
    showStatus("コピー失敗（権限エラー）", true);
  }
});

document.getElementById("btn-gemini-format").addEventListener("click", async () => {
  if (!_extractedHtml) return;
  const btn = document.getElementById("btn-gemini-format");
  btn.disabled = true;
  showStatus("Geminiに送信中...");

  // 50KB超は innerText 相当に縮小して送る（Geminiの入力制限対策）
  const MAX_BYTES = 50 * 1024;
  let payload = _extractedHtml;
  if (payload.length > MAX_BYTES) {
    payload = payload.slice(0, MAX_BYTES) + "\n<!-- ... (省略) -->";
  }
  const text = `以下のHTMLを、見た目・構造・文字を忠実に再現したきれいなHTMLに整形してください。\n\n\`\`\`html\n${payload}\n\`\`\``;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "INJECT_TEXT_TO_GEMINI", text });
  } catch (e) {
    showStatus(e.message || "通信エラー", true);
    btn.disabled = false;
    return;
  }

  btn.disabled = false;
  if (res?.success) {
    showStatus("✓ Geminiに送りました");
  } else {
    showStatus(res?.error || "送信失敗", true);
  }
});

document.getElementById("btn-scroll-capture").addEventListener("click", async () => {
  const btnScroll = document.getElementById("btn-scroll-capture");
  const btnAbort  = document.getElementById("btn-abort-scroll");
  const progressEl = document.getElementById("scroll-progress");
  const mainOnly = document.getElementById("main-only-toggle").checked;

  btnScroll.disabled = true;
  btnAbort.style.display = "";
  progressEl.style.display = "";
  progressEl.textContent = "スキャン中... 0 / ?";
  showStatus("スクロールキャプチャ開始中...");

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "START_SCROLL_CAPTURE",
      mainOnlyMode: mainOnly,
    });
  } catch (e) {
    showStatus(e.message || "通信エラー", true);
    btnScroll.disabled = false;
    btnAbort.style.display = "none";
    progressEl.style.display = "none";
    return;
  }

  btnScroll.disabled = false;
  btnAbort.style.display = "none";
  progressEl.style.display = "none";

  if (res?.success) {
    showStatus(`✓ ${res.count}枚キャプチャしました`);
    await loadImages();
  } else {
    showStatus(res?.error || "キャプチャ失敗", true);
  }
});

document.getElementById("btn-abort-scroll").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "ABORT_SCROLL_CAPTURE" });
  showStatus("中断しました");
});

document.getElementById("btn-inject").addEventListener("click", async () => {
  const btnInject = document.getElementById("btn-inject");
  btnInject.disabled = true;
  showStatus("Geminiに送信中... （メニューが一瞬開くのは正常です）");
  try {
    const res = await chrome.runtime.sendMessage({ type: "INJECT_TO_GEMINI" });
    if (res?.success) {
      showStatus("✓ Geminiに送りました。入力欄に画像が表示されます");
    } else {
      showStatus(res?.error || "注入失敗", true);
    }
  } catch (e) {
    showStatus(e.message || "通信エラー", true);
  } finally {
    btnInject.disabled = false;
    await loadImages(); // ボタンのテキストを枚数付きに戻す
  }
});

document.getElementById("btn-clear").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "CLEAR_IMAGES" });
  if (res?.success !== false) {
    showStatus("全削除しました");
  }
  await loadImages();
});

// backgroundからのリアルタイム更新（images ペイロードがあれば GET_IMAGES 往復なしで直接更新）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "IMAGE_UPDATED") {
    if (msg.images) {
      updateUI(msg.images);
    } else {
      loadImages();
    }
  } else if (msg.type === "SCROLL_PROGRESS") {
    const progressEl = document.getElementById("scroll-progress");
    if (progressEl) progressEl.textContent = `スキャン中... ${msg.current} / ${msg.total}`;
  }
});

// 初期ロード
loadImages();

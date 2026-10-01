// excalidraw-app/notes-panel.ts

import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, ExcalidrawAPIProvider, useExcalidrawAPI } from "@excalidraw/excalidraw";

import * as pdfjsLib from "pdfjs-dist";
// pdf.js needs a worker; Vite can bundle it via URL:
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();



// In dev, call the live PHP directly; in production, same-origin.
const API_BASE = import.meta.env.DEV ? "https://notes.nodanio.dk" : "";

async function saveNote(name: string) {
  const api = (window as any).notesAPI;

  // if a PDF is loaded, ensure it's uploaded and capture its state
  let pdfState: any = null;
  if (pdfDoc) {
    // upload the PDF bytes (dedupe means this is cheap if already stored)
    const hash = await ensurePdfUploaded(pdfDoc);
    pdfState = {
      hash,
      origin: pdfDoc.origin,
      mode: pdfDoc.mode,
      currentPage: pdfDoc.currentPage,
      // per-page paddings (the only per-page state that isn't derivable)
      pages: pdfDoc.pages.map(p => ({
        index: p.index,
        padTop: p.padTop, padBottom: p.padBottom,
        padLeft: p.padLeft, padRight: p.padRight,
      })),
    };
  }

  // include stashed strokes so page-mode saves don't drop hidden ink
  const elements = [...api.getSceneElements(), ...strokeStash];

  const scene = {
    elements,
    appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
    pdf: pdfState,   // ← new: PDF reference + layout
  };
  const res = await fetch(API_BASE + "/save.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, json: JSON.stringify(scene) }),
  });
  return res.json();
}

async function ensurePdfUploaded(doc: PdfDoc): Promise<string> {
  const res = await fetch(API_BASE + "/docsave.php", {
    method: "POST", headers: { "Content-Type": "application/pdf" }, body: doc.bytes,
  });
  const out = await res.json();
  fetch(API_BASE + "/docref.php?hash=" + out.hash).catch(()=>{});  // ref-count, fire-and-forget
  return out.hash;
}

async function loadNote(name: string) {
  const api = (window as any).notesAPI;
  strokeStash = [];
  const res = await fetch(API_BASE + "/load.php?name=" + encodeURIComponent(name));
  if (!res.ok) throw new Error("load failed: " + res.status);
  const scene = await res.json();

  if (scene.pdf) {
    // note HAS a pdf → mount it and restore layout
    await mountPdfFromHash(scene.pdf.hash);
    if (pdfDoc) {
      pdfDoc.origin = scene.pdf.origin;
      pdfDoc.mode = scene.pdf.mode;
      pdfDoc.currentPage = scene.pdf.currentPage;
      const byIndex = new Map(scene.pdf.pages.map((sp: any) => [sp.index, sp]));
      for (const p of pdfDoc.pages) {
        const sp: any = byIndex.get(p.index);
        if (sp) { p.padTop = sp.padTop; p.padBottom = sp.padBottom; p.padLeft = sp.padLeft; p.padRight = sp.padRight; }
      }
      layoutPages(pdfDoc);
      computeBox(pdfDoc);
      syncBox();
      await pdfDoc.rerender();
    }
  } else {
    if (pdfDoc) {
      pdfDoc.el.remove();
      pdfDoc.boxEl?.remove();
      pdfDoc = null;
    }
    padDragging = false;
    if (padHandle) { padHandle.remove(); padHandle = null; }
    padHandleTarget = null;
    if (sepLayer) { sepLayer.remove(); sepLayer = null; }
  }

  // restore elements (includes bound strokes + free strokes)
  api.updateScene({
    elements: scene.elements,
    appState: { ...api.getAppState(), ...scene.appState },
  });

  // re-apply stroke visibility for the restored mode (stash hidden pages)
  if (pdfDoc) applyStrokeVisibility(pdfDoc);
}

async function searchNotes(q: string) {
  const res = await fetch(API_BASE + "/search.php?q=" + encodeURIComponent(q));
  return res.json(); // [{name, updated_at}, ...]
}

export function initNotesPanel() {
  if (document.getElementById("notes-panel")) return; // guard against double-init

  const panel = document.createElement("div");
  panel.id = "notes-panel";
  panel.innerHTML = `
    <button id="np-toggle" title="Toggle">›</button>
    <button id="np-save"   title="Save">💾</button>
    <button id="np-load"   title="Load">📂</button>
    <button id="np-target" title="Set target">🎯</button>
    <button id="np-link"   title="Link to target">🔗</button>
    <button id="np-pdf"    title="Add PDF">📎</button>
    <button id="np-export" title="Export backup">⬇️</button>
    <button id="np-compact" title="Compact note">🗜️</button>
  `;
  document.body.appendChild(panel);

  const style = document.createElement("style");
  style.textContent = `
    #notes-panel {
      position: fixed; top: 50%; right: 0; transform: translateY(-50%);
      z-index: 100; display: flex; flex-direction: column; gap: 4px; padding: 4px;
      background: var(--island-bg-color, #fff);
      border: 1px solid var(--default-border-color, #ddd); border-right: none;
      border-radius: 10px 0 0 10px;
      box-shadow: var(--shadow-island, 0 2px 8px rgba(0,0,0,.15));
      font-family: var(--ui-font, Assistant, sans-serif);
    }
    #notes-panel button {
      width: 34px; height: 34px; cursor: pointer; font-size: 16px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      background: transparent; color: var(--text-primary-color, #1b1b1f);
      border: 1px solid transparent; border-radius: 8px;
    }
    #notes-panel button:hover { background: var(--button-hover-bg, #ececf0); }
    #notes-panel.np-collapsed button:not(#np-toggle) { display: none; }

    /* shared popup dialog */
    .np-dialog-backdrop {
      position: fixed; inset: 0; z-index: 300;
      background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center;
    }
    .np-dialog {
      width: 320px; max-height: 70vh; display: flex; flex-direction: column; gap: 10px;
      padding: 16px; border-radius: 12px;
      background: var(--island-bg-color, #fff); color: var(--text-primary-color, #1b1b1f);
      border: 1px solid var(--default-border-color, #ddd);
      box-shadow: 0 8px 32px rgba(0,0,0,.3);
      font-family: var(--ui-font, Assistant, sans-serif); font-size: 14px;
    }
    .np-dialog h3 { margin: 0; font-size: 15px; }
    .np-dialog input {
      padding: 8px 10px; border-radius: 8px;
      border: 1px solid var(--default-border-color, #ccc);
      background: var(--input-bg-color, #fff); color: inherit; font-size: 14px;
    }
    .np-dialog-list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
    .np-dialog-list .np-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; }
    .np-dialog-list .np-item:hover { background: var(--button-hover-bg, #eef); }
    .np-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .np-dialog-actions button {
      padding: 6px 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--default-border-color, #ccc);
      background: var(--button-bg, #f5f5f5); color: inherit;
    }
  `;
  document.head.appendChild(style);

    function toast(message: string) {
    (window as any).notesAPI?.setToast?.({ message, duration: 2000 });
  }

    (window as any).deleteDoc = (hash: string) =>
    fetch(API_BASE + "/docdelete.php?hash=" + hash).then(r => r.json()).then(console.log)

  function makeDialog(): { box: HTMLDivElement; close: () => void } {
    const backdrop = document.createElement("div");
    backdrop.className = "np-dialog-backdrop";
    const box = document.createElement("div");
    box.className = "np-dialog";
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    return { box, close };
  }

  let currentName = "";                       // last saved/loaded note
  let linkTarget: { note: string; ids: string[] } | null = null;
  const api = () => (window as any).notesAPI;
  const selectedIds = () => Object.keys(api().getAppState().selectedElementIds || {});

  // SAVE — popup asks for name
  function openSaveDialog() {
    const { box, close } = makeDialog();
    box.innerHTML = `
      <h3>Save note</h3>
      <input class="np-d-name" placeholder="MATH1/Lecture 1" />
      <div class="np-dialog-actions">
        <button class="np-d-cancel">Cancel</button>
        <button class="np-d-ok">Save</button>
      </div>`;
    const input = box.querySelector(".np-d-name") as HTMLInputElement;
    input.value = currentName;
    input.focus();
    input.select();
    const doIt = async () => {
      const name = input.value.trim();
      if (!name) return;
      try { await saveNote(name); currentName = name; toast("saved ✓"); close(); }
      catch { toast("save failed"); }
    };
    box.querySelector(".np-d-ok")!.addEventListener("click", doIt);
    box.querySelector(".np-d-cancel")!.addEventListener("click", close);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doIt(); });
  }

  // LOAD — popup with search + scrollable list
  function openLoadDialog() {
    const { box, close } = makeDialog();
    box.innerHTML = `
      <h3>Load note</h3>
      <input class="np-d-search" placeholder="Search…" />
      <div class="np-dialog-list"></div>`;
    const search = box.querySelector(".np-d-search") as HTMLInputElement;
    const list = box.querySelector(".np-dialog-list") as HTMLDivElement;
    search.focus();
    let timer: any;
    const refresh = async (q: string) => {
      const rows = await searchNotes(q);
      list.innerHTML = "";
      if (!rows.length) { list.innerHTML = `<div class="np-item" style="color:var(--text-secondary-color,#888)">no notes</div>`; return; }
            for (const row of rows) {
        const item = document.createElement("div");
        item.className = "np-item";
        item.style.cssText = "display:flex; justify-content:space-between; align-items:center;";
        const label = document.createElement("span");
        label.textContent = row.name;
        label.style.cssText = "flex:1; cursor:pointer;";
        label.addEventListener("click", async () => {
          try { await loadNote(row.name); currentName = row.name; toast("loaded ✓"); close(); }
          catch { toast("load failed"); }
        });
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.style.cssText = "border:none; background:none; cursor:pointer; font-size:14px;";
        del.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${row.name}"?`)) return;
          await fetch(API_BASE + "/notedelete.php?name=" + encodeURIComponent(row.name));
          toast("deleted");
          refresh(search.value);  // refresh the list
        });
        item.appendChild(label);
        item.appendChild(del);
        list.appendChild(item);
      }
    };
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => refresh(search.value), 200); });
    refresh("");
  }

  // SET TARGET / LINK — act on selection, no popup
  function doSetTarget() {
    const ids = selectedIds();
    if (!currentName) return toast("save or load a note first");
    if (!ids.length) return toast("select target strokes");
    linkTarget = { note: currentName, ids };
    toast(`target set (${ids.length})`);
  }
  async function doLink() {
    if (!linkTarget) return toast("set a target first");
    const ids = selectedIds();
    if (!ids.length) return toast("select source strokes");
    api().updateScene({
      elements: api().getSceneElements().map((e: any) =>
        ids.includes(e.id)
          ? { ...e, customData: { ...e.customData, noteLink: { note: linkTarget!.note, ids: linkTarget!.ids } } }
          : e),
    });
    if (currentName) { try { await saveNote(currentName); } catch {} }
    toast(`linked ${ids.length} → ${linkTarget.note}`);
  }

  // wire rail
  panel.querySelector("#np-save")!.addEventListener("click", openSaveDialog);
  panel.querySelector("#np-load")!.addEventListener("click", openLoadDialog);
  panel.querySelector("#np-target")!.addEventListener("click", doSetTarget);
  panel.querySelector("#np-link")!.addEventListener("click", doLink);
  panel.querySelector("#np-pdf")!.addEventListener("click", () => {
    if (pdfDoc) {
      if (!confirm("A PDF is already loaded. Adding another will replace it (and unsaved notes on it will be lost). Save first? Click Cancel to stop, OK to replace anyway.")) return;
    }
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/pdf";
    inp.onchange = () => inp.files && mountPdf(inp.files[0]).catch(e => { console.error(e); toast("PDF load failed"); });
    inp.click();
  });
  
  const toggleBtn = panel.querySelector("#np-toggle") as HTMLButtonElement;
  toggleBtn.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("np-collapsed");
    toggleBtn.textContent = collapsed ? "‹" : "›";
  });

  panel.querySelector("#np-export")!.addEventListener("click", async () => {
    const api = (window as any).notesAPI;
    let pdfState: any = null;
    if (pdfDoc) {
      pdfState = { hash: null, origin: pdfDoc.origin, mode: pdfDoc.mode, currentPage: pdfDoc.currentPage,
        pages: pdfDoc.pages.map(p => ({ index: p.index, padTop: p.padTop, padBottom: p.padBottom, padLeft: p.padLeft, padRight: p.padRight })) };
    }
    const scene = { elements: [...api.getSceneElements(), ...strokeStash],
      appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor }, pdf: pdfState };
    const blob = new Blob([JSON.stringify(scene)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (currentName || "note").replace(/\//g, "_") + ".json";
    a.click();
    toast("backup downloaded");
  });

  panel.querySelector("#np-compact")!.addEventListener("click", () => {
    const api = (window as any).notesAPI;
    const all = [...api.getSceneElements(), ...strokeStash];
    let before = 0, after = 0;
    const compacted = all.map((e: any) => {
      if (e.type !== "freedraw") return e;
      before += JSON.stringify(e).length;
      const { points, pressures } = compactStroke(e.points, e.pressures);
      const ne = { ...e, points, pressures, customData: { ...e.customData, compacted: true } };
      after += JSON.stringify(ne).length;
      return ne;
    });
    // split back into scene vs stash by whether they were stashed
    const stashIds = new Set(strokeStash.map((s: any) => s.id));
    strokeStash = compacted.filter((e: any) => stashIds.has(e.id));
    api.updateScene({ elements: compacted.filter((e: any) => !stashIds.has(e.id)) });
    toast(`compacted ${(before/1024/1024).toFixed(1)}MB → ${(after/1024/1024).toFixed(1)}MB`);
  });

  const clusters = document.createElement("div");
  clusters.id = "np-clusters";
  clusters.innerHTML = `
    <button id="npc-delpdf" title="Remove PDF">🗑</button>
    <button id="npc-mode" title="Mode">📄</button>
    <button id="npc-prev" title="Prev">◀</button>
    <button id="npc-next" title="Next">▶</button>
  `;
  document.body.appendChild(clusters);
  const cstyle = document.createElement("style");
  cstyle.textContent = `
    #np-clusters { position: fixed; top: 70px; right: 60px; z-index: 100;
      display: flex; gap: 6px; }
    #np-clusters button { width: 40px; height: 40px; cursor: pointer; font-size: 18px;
      border-radius: 8px; border: 1px solid var(--default-border-color,#ddd);
      background: var(--island-bg-color,#fff); box-shadow: var(--shadow-island,0 2px 8px rgba(0,0,0,.15)); }
  `;
  document.head.appendChild(cstyle);

    clusters.querySelector("#npc-mode")!.addEventListener("click", () => {
    const doc = docAtViewCenter();
    if (!doc) return toast("no PDF loaded");
    const next = doc.mode === "full" ? "page" : doc.mode === "page" ? "scroll" : "full";
    setMode(doc, next);
    toast(next + " mode");
    (clusters.querySelector("#npc-prev") as HTMLElement).style.display = doc.mode === "page" ? "" : "none";
    (clusters.querySelector("#npc-next") as HTMLElement).style.display = doc.mode === "page" ? "" : "none";
  });
  clusters.querySelector("#npc-prev")!.addEventListener("click", () => {
    const doc = docAtViewCenter();
    if (!doc || doc.mode !== "page") return;
    goToPage(doc, doc.currentPage - 1); toast(`page ${doc.currentPage}`);
  });
  clusters.querySelector("#npc-next")!.addEventListener("click", () => {
    const doc = docAtViewCenter();
    if (!doc || doc.mode !== "page") return;
    goToPage(doc, doc.currentPage + 1); toast(`page ${doc.currentPage}`);
  });
  // flip buttons hidden until page-mode
  (clusters.querySelector("#npc-prev") as HTMLElement).style.display = "none";
  (clusters.querySelector("#npc-next") as HTMLElement).style.display = "none";

    clusters.querySelector("#npc-delpdf")!.addEventListener("click", async () => {
    if (!pdfDoc || !pdfDoc.bytes) return toast("no PDF loaded");
    if (!confirm("Remove this PDF from the server?")) return;
    // hash the bytes to get the doc id (same sha-256 the server uses)
    const buf = await crypto.subtle.digest("SHA-256", pdfDoc.bytes);
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    await fetch(API_BASE + "/docdelete.php?hash=" + hash).catch(()=>{});
    // tear down the loaded PDF locally
    pdfDoc.el.remove();
    pdfDoc.boxEl?.remove();
    pdfDoc = null;
    if (padHandle) { padHandle.remove(); padHandle = null; }
    padHandleTarget = null;
    if (sepLayer) { sepLayer.remove(); sepLayer = null; }
    strokeStash = [];
    toast("PDF removed");
  });

  document.addEventListener("wheel", (e) => {
    if (!pdfDoc || pdfDoc.mode !== "scroll" || !pdfDoc.scrollWindow) return;
    const st = (window as any).notesAPI.getAppState();
    const z = st.zoom.value;
    const wx = e.clientX / z - st.scrollX;
    const wy = e.clientY / z - st.scrollY;
    const w = pdfDoc.scrollWindow;
    const inside = wx >= w.x && wx <= w.x + w.w && wy >= w.y && wy <= w.y + w.h;
    if (!inside) return;
    e.preventDefault();
    e.stopPropagation();
    (e as any).stopImmediatePropagation?.();
    pdfDoc.scrollOffset = Math.max(0, (pdfDoc.scrollOffset || 0) + e.deltaY / z);
    pdfDoc.rerender();
    applyScrollInk(pdfDoc);
  }, { capture: true, passive: false });

  document.addEventListener("pointermove", (e) => {
    if (!padDragging) updatePadHandle(e.clientX, e.clientY);
  });

  (window as any).openNotePopup = openNotePopup;

  // detect clicks on linked strokes
  const mainApi = (window as any).notesAPI;
  if (mainApi?.onPointerUp) {
    mainApi.onPointerUp((activeTool: any, _state: any, _event: any) => {
      // --- classify a just-drawn stroke ---
      const els = mainApi.getSceneElements();
      const last = els[els.length - 1];
      if (last && last.type === "freedraw" && last.customData?.page === undefined && !last.customData?.compacted) {
        // compact geometry (pressure remap + round + thin) once, on completion
        const { points, pressures } = compactStroke(last.points, last.pressures);
        mainApi.updateScene({
          elements: mainApi.getSceneElements().map((e: any) =>
            e.id === last.id
              ? { ...e, points, pressures, customData: { ...e.customData, compacted: true } }
              : e),
        });
        classifyStroke({ ...last, points, pressures });  // classify the compacted version
      }

      // --- existing link-click detection ---
      const appState = mainApi.getAppState();
      const selectedIds = Object.keys(appState.selectedElementIds || {});
      if (selectedIds.length !== 1) return;
      const el = els.find((e: any) => e.id === selectedIds[0]);
      const link = el?.customData?.noteLink;
      if (link) {
        (window as any).openNotePopup?.(link.note, link.ids || []);
      }
    });
  }

    // keep bound strokes' page-local offset in sync when user moves/edits them
  if (mainApi?.onChange) {
    let syncing = false;
    mainApi.onChange(() => {
      if (!pdfDoc || syncing || pdfDoc.mode === "scroll") return;
      const doc = pdfDoc;
      const pageById = new Map(doc.pages.map(p => [p.index, p]));
      const els = mainApi.getSceneElements();
      let needsUpdate = false;

      const updated = els.map((e: any) => {
        const cd = e.customData;
        if (cd?.page === undefined || cd.pageX === undefined) return e;
        const p = pageById.get(cd.page);
        if (!p) return e;
        // what canvas pos SHOULD be, given current offset + page position
        const expectedX = doc.origin.x + cd.pageX;
        const expectedY = p.bandTop + cd.pageY;
        // if actual differs (user moved it), re-derive the offset
        if (Math.abs(e.x - expectedX) > 0.01 || Math.abs(e.y - expectedY) > 0.01) {
          needsUpdate = true;
          return { ...e, customData: {
            ...cd,
            pageX: e.x - doc.origin.x,
            pageY: e.y - p.bandTop,
          } };
        }
        return e;
      });

      if (needsUpdate) {
        syncing = true;
        mainApi.updateScene({ elements: updated });
        syncing = false;
      }
    });
  }



  //PDF SUPPORT
    if (mainApi?.onScrollChange) {
    let lastRenderTime = 0;
    mainApi.onScrollChange(() => {
      syncPdf();
      syncBox();
      const now = performance.now();
      if (now - lastRenderTime > 100) {
        lastRenderTime = now;
        for (const d of pdfDocs) d.rerender();   // ← all docs
      }
      if (padHandleTarget && !padDragging) {
        const st2 = mainApi.getAppState();
        showPadHandleAt(padHandleTarget.page, padHandleTarget.side, st2.zoom.value, st2);  // see note
      }
      scheduleSharpen();
    });
  }

  (window as any).loadPdf = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/pdf";
    inp.onchange = () => inp.files && mountPdf(inp.files[0]).catch(e => console.error("PDF mount failed:", e));
    inp.click();
  };

  (window as any).setPagePad = (pageIndex: number, top: number, bottom: number, left = 0, right = 0) => {
    if (!pdfDoc) return;
    const p = pdfDoc.pages.find(pp => pp.index === pageIndex);
    if (!p) return;
    p.padTop = Math.max(0, top);
    p.padBottom = Math.max(0, bottom);
    p.padLeft = Math.max(0, left);      // clamp ≥ 0 (your rule)
    p.padRight = Math.max(0, right);
    layoutPages(pdfDoc);          // recompute vertical bands (top/bottom cascade)
    computeBox(pdfDoc);                 // recompute box dimensions (incl. new width)
    syncBox();                          // reposition the box div
    pdfDoc.rerender();                  // re-render pages at new positions
  };
}

function computeBox(doc: PdfDoc) {
  const pages = doc.pages;
  const halfW = Math.max(...pages.map(p => p.pdfW)) / 2;
  const maxLeft = Math.max(...pages.map(p => p.padLeft));
  const maxRight = Math.max(...pages.map(p => p.padRight));

  if (doc.mode === "scroll" && doc.scrollWindow) {
    const w = doc.scrollWindow;
    // width computed from pages; height = window height; y = window y
    doc.box = {
      x: doc.origin.x - halfW - maxLeft,
      y: w.y,
      w: halfW * 2 + maxLeft + maxRight,
      h: w.h,
    };
    // keep the window's x/width synced to the computed width (so the clip matches)
    w.x = doc.box.x;
    w.w = doc.box.w;
    return;
  }

  if (doc.mode === "page") {
    const cur = pages.find(p => p.index === doc.currentPage) || pages[0];
    doc.box = {
      x: doc.origin.x - halfW - maxLeft,
      y: cur.bandTop,
      w: halfW * 2 + maxLeft + maxRight,
      h: cur.bandBottom - cur.bandTop,
    };
    return;
  }

  const top = pages[0].bandTop;
  const bottom = pages[pages.length - 1].bandBottom;
  doc.box = {
    x: doc.origin.x - halfW - maxLeft,
    y: top,
    w: halfW * 2 + maxLeft + maxRight,
    h: bottom - top,
  };
}

function ensurePopupStyles() {
  if (document.getElementById("note-popup-styles")) return;
  const s = document.createElement("style");
  s.id = "note-popup-styles";
  s.textContent = `
    .note-popup { position: fixed; top: 90px; left: 300px; z-index: 200;
      width: 440px; height: 340px; background:#fff; border:1px solid #bbb;
      border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.25);
      display:flex; flex-direction:column; overflow:hidden; resize:both; }
    .note-popup-bar { display:flex; justify-content:space-between; align-items:center;
      padding:4px 8px; background:#f0f0f0; cursor:move; font-size:13px;
      font-family:Assistant,sans-serif; user-select:none; }
    .note-popup-body { flex:1; position:relative; }
    .note-popup button { border:none; background:none; cursor:pointer; font-size:14px; padding:2px 6px; }
  `;
  document.head.appendChild(s);
}

function PopupCanvas(props: { scene: any; targetIds: string[] }) {
  const api = useExcalidrawAPI() as any;
    useEffect(() => {
    if (!api) return;
    let cancelled = false;

    const frame = (tries = 0) => {
      if (cancelled) return;
      const st = api.getAppState();
      if ((!st.width || !st.height) && tries < 40) {
        requestAnimationFrame(() => frame(tries + 1));
        return;
      }
      api.refresh();
      // let refresh apply, THEN frame on the next tick
      requestAnimationFrame(() => {
        if (cancelled) return;
        const els = api.getSceneElements();
        const targets = props.targetIds.length
          ? els.filter((el: any) => props.targetIds.includes(el.id))
          : els;
        if (targets.length) {
          api.setViewport({ target: targets, fit: "scale-down", animation: false });
        }
        api.setActiveTool({ type: "hand" });
      });
    };
    frame();
    return () => { cancelled = true; };
  }, [api, props.targetIds]);

  return React.createElement(Excalidraw, {
    initialData: {
      elements: props.scene.elements,
      appState: props.scene.appState,
    },
    viewModeEnabled: true,
  });
}

export async function openNotePopup(noteName: string, targetIds: string[] = []) {
  let scene;
  try {
    const res = await fetch(API_BASE + "/load.php?name=" + encodeURIComponent(noteName));
    if (!res.ok) throw new Error("load failed: " + res.status);
    scene = await res.json();
  } catch (e) { console.error(e); return; }

  ensurePopupStyles();

  const popup = document.createElement("div");
  popup.className = "note-popup";
  popup.innerHTML = `
    <div class="note-popup-bar">
      <span class="note-popup-title"></span>
      <span>
        <button class="note-popup-max" title="Open full">⤢</button>
        <button class="note-popup-close" title="Close">✕</button>
      </span>
    </div>
    <div class="note-popup-body"></div>`;
  (popup.querySelector(".note-popup-title") as HTMLElement).textContent = noteName;
  document.body.appendChild(popup);

  const body = popup.querySelector(".note-popup-body") as HTMLElement;
  const root = createRoot(body);
  root.render(
    React.createElement(
      ExcalidrawAPIProvider,
      null,
      React.createElement(PopupCanvas, { scene, targetIds }),
    ),
  );

  popup.querySelector(".note-popup-close")!.addEventListener("click", () => { root.unmount(); popup.remove(); });

  popup.querySelector(".note-popup-max")!.addEventListener("click", async () => {
    root.unmount(); popup.remove();
    await loadNote(noteName);
    const api = (window as any).notesAPI;
    const targets = api.getSceneElements().filter((el: any) => targetIds.includes(el.id));
        if (targets.length) api.setViewport({ target: targets, fit: "scale-down", animation: false });
  });

  const bar = popup.querySelector(".note-popup-bar") as HTMLElement;
  bar.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();

    const startX = e.clientX, startY = e.clientY;
    const rect = popup.getBoundingClientRect();

    // full-screen shield that captures all pointer events during the drag,
    // so the popup's canvas can't steal the move events
    const shield = document.createElement("div");
    shield.style.cssText = "position:fixed; inset:0; z-index:9999; cursor:move;";
    document.body.appendChild(shield);

    const move = (ev: PointerEvent) => {
      popup.style.left = rect.left + (ev.clientX - startX) + "px";
      popup.style.top = rect.top + (ev.clientY - startY) + "px";
    };
    const up = () => {
      shield.removeEventListener("pointermove", move);
      shield.removeEventListener("pointerup", up);
      shield.remove();
    };
    shield.addEventListener("pointermove", move);
    shield.addEventListener("pointerup", up);
    shield.setPointerCapture(e.pointerId);
  });
}

//PDF SUPPORT
// ---- Multi-page crisp PDF underlay ----
type PageGeom = {
  pdfW: number; pdfH: number;
  padTop: number; padBottom: number;
  padLeft: number; padRight: number;
};
type LaidPage = PageGeom & {
  index: number;
  bandTop: number; pdfTop: number; pdfBottom: number; bandBottom: number;
  canvas: HTMLCanvasElement;
  _patch?: { wx: number; wy: number; ww: number; wh: number; scale: number };
};
type PdfDoc = {
  id: string;
  el: HTMLDivElement;
  pdf: any;
  pages: LaidPage[];
  padWidth: number;
  origin: { x: number; y: number };
  box: { x: number; y: number; w: number; h: number };
  boxEl?: HTMLDivElement;
  sepEl?: HTMLDivElement;
  mode: "full" | "page" | "scroll";        // ← add "scroll"
  scrollWindow?: { x: number; y: number; w: number; h: number };  // world-placed window
  scrollOffset?: number;                    // how far scrolled within (world units), stage 2
  currentPage: number;
  bytes?: ArrayBuffer;
  rerender: () => Promise<void>;
};

let pdfDocs: PdfDoc[] = [];

// doc whose box/bounds contain a world point (with sectoring early-out)
function docAtPoint(wx: number, wy: number): PdfDoc | null {
  for (const d of pdfDocs) {
    const b = d.box;
    if (wx < b.x || wx > b.x + b.w) continue;   // sector early-out
    if (wy < b.y || wy > b.y + b.h) continue;
    return d;
  }
  return null;
}

// doc nearest the current view center (for modes / page-flip)
function docAtViewCenter(): PdfDoc | null {
  if (pdfDocs.length === 0) return null;
  if (pdfDocs.length === 1) return pdfDocs[0];
  const st = (window as any).notesAPI.getAppState();
  const z = st.zoom.value;
  const cx = (window.innerWidth / 2) / z - st.scrollX;
  const cy = (window.innerHeight / 2) / z - st.scrollY;
  // first a doc actually under the center, else nearest box-center
  const under = docAtPoint(cx, cy);
  if (under) return under;
  let best = pdfDocs[0], bestD = Infinity;
  for (const d of pdfDocs) {
    const dx = (d.box.x + d.box.w / 2) - cx, dy = (d.box.y + d.box.h / 2) - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return best;
}

// Recompute each page's world-space band from paddings (the cascade).
function layoutPages(doc: PdfDoc) {
  if (doc.mode === "page") {
    // all pages share one slot; frame uses max padding across pages
    const maxTop = Math.max(...doc.pages.map(p => p.padTop));
    for (const p of doc.pages) {
      p.bandTop = doc.origin.y;
      p.pdfTop = doc.origin.y + maxTop;       // consistent top across all pages
      p.pdfBottom = p.pdfTop + p.pdfH;
      p.bandBottom = p.pdfBottom + Math.max(...doc.pages.map(pp => pp.padBottom));
    }
    return;
  }
  // full mode: stack vertically (existing)
  let y = doc.origin.y;
  for (const p of doc.pages) {
    p.bandTop = y;
    p.pdfTop = y + p.padTop;
    p.pdfBottom = p.pdfTop + p.pdfH;
    p.bandBottom = p.pdfBottom + p.padBottom;
    y = p.bandBottom;
  }
}

async function mountPdf(file: File) {
  const buf = await file.arrayBuffer();
  await mountPdfFromBuffer(buf);
}

async function mountPdfFromBuffer(buf: ArrayBuffer) {
  // clear the padding handle from any previous document
  padDragging = false;
  if (padHandle) { padHandle.remove(); padHandle = null; }
  padHandleTarget = null;
  if (sepLayer) { sepLayer.remove(); sepLayer = null; }

  const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;

  const el = document.createElement("div");
  el.id = "pdf-layer";
  el.style.cssText = "position:fixed; inset:0; z-index:0; overflow:hidden; pointer-events:none;";
  document.body.appendChild(el);

  // measure every page (cheap — no render), build canvases
  const pages: LaidPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute; left:0; top:0; transform-origin:0 0;";
    el.appendChild(canvas);
    pages.push({
      index: i, pdfW: vp.width, pdfH: vp.height,
      padTop: 0, padBottom: 0,
      padLeft: 0, padRight: 0,
      bandTop: 0, pdfTop: 0, pdfBottom: 0, bandBottom: 0,
      canvas,
    });
  }

    const doc: PdfDoc = {
    id: "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),  // ← add
    el, pdf, pages, padWidth: 0,
    origin: { x: 0, y: 0 },
    box: { x: 0, y: 0, w: 0, h: 0 },
    mode: "full", currentPage: 1,
    bytes: buf,
    rerender: async () => {},
  };
  pdfDocs.push(doc);
  layoutPages(doc);
  computeBox(doc);
  createBox(doc);

  const renderPage = async (p: LaidPage, zoom: number, scrollX: number, scrollY: number) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const worldLeft = -scrollX, worldTop = -scrollY;
    const worldRight = vw / zoom - scrollX, worldBottom = vh / zoom - scrollY;
    const mX = (worldRight - worldLeft) * 0.5, mY = (worldBottom - worldTop) * 0.5;

    const pageLeft = doc.origin.x - p.pdfW / 2;
    const pageRight = doc.origin.x + p.pdfW / 2;
    const renderScale = zoom;
    const g = 1 / renderScale;
    const wx = Math.max(pageLeft, Math.floor((worldLeft - mX) / g) * g);
    const wy = Math.max(p.pdfTop, Math.floor((worldTop - mY) / g) * g);
    const wxr = Math.min(pageRight, worldRight + mX);
    const wyb = Math.min(p.pdfBottom, worldBottom + mY);
    const ww = wxr - wx, wh = wyb - wy;

    if (ww <= 0 || wh <= 0) { p.canvas.style.display = "none"; return; }
    p.canvas.style.display = "";

    const sizeTol = Math.max(ww, wh) * 0.1;
    if (p._patch && p.canvas.style.display !== "none" &&
        Math.abs(p._patch.wx - wx) < g &&
        Math.abs(p._patch.wy - wy) < g &&
        Math.abs(p._patch.ww - ww) < sizeTol &&
        Math.abs(p._patch.wh - wh) < sizeTol &&
        Math.abs(p._patch.scale - renderScale) / renderScale < 0.02) return;

    const page = await doc.pdf.getPage(p.index);
    const vp = page.getViewport({
      scale: renderScale,
      offsetX: -Math.round((wx - pageLeft) * renderScale),
      offsetY: -Math.round((wy - p.pdfTop) * renderScale),
    });

    const pxW = Math.ceil(ww * renderScale);
    const pxH = Math.ceil(wh * renderScale);

    const off = document.createElement("canvas");
    off.width = pxW;
    off.height = pxH;
    const offCtx = off.getContext("2d")!;
    await page.render({ canvas: off, canvasContext: offCtx, viewport: vp } as any).promise;

    p.canvas.width = pxW;
    p.canvas.height = pxH;
    p.canvas.style.width = (pxW / renderScale) + "px";
    p.canvas.style.height = (pxH / renderScale) + "px";
    const ctx = p.canvas.getContext("2d")!;
    ctx.drawImage(off, 0, 0);
    p._patch = { wx, wy, ww, wh, scale: renderScale };

    const st2 = (window as any).notesAPI.getAppState();
    const z = st2.zoom.value;
    const sx = Math.round((wx + st2.scrollX) * z);
    const sy = Math.round((wy + st2.scrollY) * z);
    p.canvas.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
  };

  doc.rerender = async () => {
    const st = (window as any).notesAPI.getAppState();
    const zoom = st.zoom.value;
    const off = doc.mode === "scroll" ? (doc.scrollOffset || 0) : 0;
    for (const p of doc.pages) {
      if (doc.mode === "page" && p.index !== doc.currentPage) {
        p.canvas.style.display = "none";
        continue;
      }
      await renderPage(p, zoom, st.scrollX, st.scrollY - off);
    }
    syncPdf();
  };

  await doc.rerender();
  syncPdf();
  (window as any).notesAPI.updateScene({ appState: { viewBackgroundColor: "transparent" } });
}

async function mountPdfFromHash(hash: string) {
  const res = await fetch(API_BASE + "/docload.php?hash=" + hash);
  if (!res.ok) throw new Error("pdf fetch failed");
  const buf = await res.arrayBuffer();
  await mountPdfFromBuffer(buf);
}

// position every page canvas to match Excalidraw pan/zoom
function syncPdf() {
  const st = (window as any).notesAPI.getAppState();
  const zoom = st.zoom.value;
  for (const doc of pdfDocs) {
    const off = doc.mode === "scroll" ? (doc.scrollOffset || 0) : 0;
    for (const p of doc.pages) {
      if (!p._patch) continue;
      const sx = Math.round((p._patch.wx + st.scrollX) * zoom);
      const sy = Math.round((p._patch.wy - off + st.scrollY) * zoom);
      p.canvas.style.transform = `translate(${sx}px, ${sy}px) scale(${zoom})`;
    }
    drawSeparators(doc);
    applyScrollClip(doc);
  }
}

// debounced crispen after motion stops
let sharpenTimer: any;
function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(async () => {
    for (const d of pdfDocs) await d.rerender();
  }, 200);
}

const HANDLE = 14; // screen px, fixed size so handles stay grabbable at any zoom

function createBox(doc: PdfDoc) {
  const box = document.createElement("div");
  box.id = "pdf-box";
  box.style.cssText =
    "position:fixed; box-sizing:border-box; border:2px solid #4a90d9; " +
    "background:transparent; pointer-events:none; z-index:150;" ; // interior click-through

  // a border-only hit area: 4 thin edge strips with pointer-events, leaving interior free
  const mkEdge = (css: string) => {
    const e = document.createElement("div");
    e.style.cssText = "position:absolute; pointer-events:auto; " + css;
    box.appendChild(e);
    return e;
  };
  const edgeThick = 8;
  const top = mkEdge(`left:0;right:0;top:0;height:${edgeThick}px;cursor:move;`);
  const bottom = mkEdge(`left:0;right:0;bottom:0;height:${edgeThick}px;cursor:move;`);
  const left = mkEdge(`top:0;bottom:0;left:0;width:${edgeThick}px;cursor:move;`);
  const right = mkEdge(`top:0;bottom:0;right:0;width:${edgeThick}px;cursor:move;`);
  [top, bottom, left, right].forEach(e => attachMove(e, doc));

  document.body.appendChild(box);
  doc.boxEl = box;
  syncBox();
}

// position + size the box div to match world coords through the canvas transform
function syncBox() {
  const st = (window as any).notesAPI.getAppState();
  const z = st.zoom.value;
  for (const doc of pdfDocs) {
    if (!doc.boxEl) continue;
    const b = doc.box;
    const sx = (b.x + st.scrollX) * z;
    const sy = (b.y + st.scrollY) * z;
    doc.boxEl.style.left = sx + "px";
    doc.boxEl.style.top = sy + "px";
    doc.boxEl.style.width = b.w * z + "px";
    doc.boxEl.style.height = b.h * z + "px";
  }
}

// screen-pixel drag → world-delta, via a shield (same trick as the popup)
function dragWithShield(onMove: (dxWorld: number, dyWorld: number) => void) {
  return (e: PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const z = (window as any).notesAPI.getAppState().zoom.value;
    const sx = e.clientX, sy = e.clientY;
    const shield = document.createElement("div");
    shield.style.cssText = "position:fixed; inset:0; z-index:9999;";
    document.body.appendChild(shield);
    const move = (ev: PointerEvent) => {
      onMove((ev.clientX - sx) / z, (ev.clientY - sy) / z);
    };
    const up = () => {
      shield.removeEventListener("pointermove", move);
      shield.removeEventListener("pointerup", up);
      shield.remove();
    };
    shield.addEventListener("pointermove", move);
    shield.addEventListener("pointerup", up);
    shield.setPointerCapture(e.pointerId);
  };
}

function attachMove(el: HTMLElement, doc: PdfDoc) {
  el.addEventListener("pointerdown", (e) => {
    const start = { ...doc.origin };
    dragWithShield((dx, dy) => {
      doc.origin.x = start.x + dx;
      doc.origin.y = start.y + dy;
      layoutPages(doc);
      computeBox(doc);
      repositionBoundStrokes(doc)
      syncBox();
      doc.rerender();   // ← re-render pages at new positions (not just syncPdf)
    })(e as PointerEvent);
  });
}

function repositionBoundStrokes(doc: PdfDoc) {
  const api = (window as any).notesAPI;
  const pageById = new Map(doc.pages.map(p => [p.index, p]));
  api.updateScene({
    elements: api.getSceneElements().map((e: any) => {
      const cd = e.customData;
      if (cd?.page === undefined || cd.pageX === undefined) return e;
      const p = pageById.get(cd.page);
      if (!p) return e;
      return { ...e, x: doc.origin.x + cd.pageX, y: p.bandTop + cd.pageY };
    }),
  });
}

function classifyStroke(el: any) {
  if (el.type !== "freedraw") return;

  // find which doc's box the stroke STARTED in (accounting for scroll offset)
  // we must test against each doc's own scroll offset, so check per-doc
  let doc: PdfDoc | null = null;
  let off = 0;
  for (const d of pdfDocs) {
    const dOff = d.mode === "scroll" ? (d.scrollOffset || 0) : 0;
    if (pointInBox(d, el.x, el.y + dOff)) { doc = d; off = dOff; break; }
  }
  if (!doc) return;   // not in any doc's box → free stroke, leave untagged

  const startY = el.y + off;
  const page = pageAtWorldY(doc, startY);
  if (!page) return;

  const pts = el.points;
  if (!pts || pts.length === 0) return;
  let minX = Infinity, maxX = -Infinity;
  for (const pt of pts) {
    if (pt[0] < minX) minX = pt[0];
    if (pt[0] > maxX) maxX = pt[0];
  }
  const leftWorldX = el.x + minX;
  const rightWorldX = el.x + maxX;

  const contentLeft = doc.origin.x - page.pdfW / 2;
  const contentRight = doc.origin.x + page.pdfW / 2;
  const extraMargin = el.height;
  let extended = false;

  if (rightWorldX > contentRight) {
    page.padRight = Math.max(page.padRight, (rightWorldX - contentRight) + extraMargin);
    extended = true;
  }
  if (leftWorldX < contentLeft) {
    page.padLeft = Math.max(page.padLeft, (contentLeft - leftWorldX) + extraMargin);
    extended = true;
  }

  if (extended) {
    layoutPages(doc);
    computeBox(doc);
    syncBox();
    doc.rerender();
  }

  const api = (window as any).notesAPI;
  const dref = doc;   // capture for the closure
  api.updateScene({
    elements: api.getSceneElements().map((e: any) =>
      e.id === el.id
        ? { ...e, customData: {
            ...e.customData,
            docId: dref.id,             // ← which PDF this stroke belongs to
            page: page.index,
            pageX: el.x - dref.origin.x,
            pageY: (el.y + off) - page.bandTop,
          } }
        : e),
  });

  if (doc.mode === "scroll") applyScrollInk(doc);
}

// Which page's band contains a given world Y? Returns the page or null.
function pageAtWorldY(doc: PdfDoc, worldY: number): LaidPage | null {
  for (const p of doc.pages) {
    if (worldY >= p.bandTop && worldY <= p.bandBottom) return p;
  }
  return null;
}

// Is a world point inside the current box?
function pointInBox(doc: PdfDoc, wx: number, wy: number): boolean {
  const b = doc.box;
  return wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
}

function setMode(doc: PdfDoc, mode: "full" | "page" | "scroll") {
  doc.mode = mode;
  if (mode === "scroll" && !doc.scrollWindow) {
    const pw = Math.max(...doc.pages.map(p => p.pdfW));
    const ph = doc.pages[0].pdfH;
    doc.scrollWindow = { x: doc.origin.x - pw / 2, y: doc.origin.y, w: pw, h: ph * 0.6 };
    doc.scrollOffset = 0;
  }
  layoutPages(doc);
  computeBox(doc);
  applyStrokeVisibility(doc);
  syncBox();
  doc.rerender();
  applyScrollClip(doc);
  if (mode === "scroll") applyScrollInk(doc);   // ← moved here, AFTER layout
  if (mode === "page") {
    const api = (window as any).notesAPI;
    const st = api.getAppState();
    const vw = window.innerWidth, vh = window.innerHeight;
    const b = doc.box;
    // zoom to fit the box with a margin (0.9 = leave 10% padding)
    const zoom = Math.min(vw / b.w, vh / b.h) * 0.9;
    // center the box: scroll so box center maps to screen center
    // screen_center = (world + scroll) * zoom  →  scroll = screen_center/zoom - world_center
    const scrollX = (vw / 2) / zoom - (b.x + b.w / 2);
    const scrollY = (vh / 2) / zoom - (b.y + b.h / 2);
    api.updateScene({ appState: { ...st, scrollX, scrollY, zoom: { value: zoom } } });
  }
}

function goToPage(doc: PdfDoc, index: number) {
  doc.currentPage = Math.max(1, Math.min(doc.pages.length, index));
  layoutPages(doc);
  computeBox(doc);
  applyStrokeVisibility(doc); 
  syncBox();
  doc.rerender();
}




let strokeStash: any[] = [];   // bound strokes currently hidden (out of scene)

function applyStrokeVisibility(doc: PdfDoc) {
  const api = (window as any).notesAPI;
  const pageById = new Map(doc.pages.map(p => [p.index, p]));

  // 1. pool: all bound strokes, whether in-scene or stashed
  const inScene = api.getSceneElements();
  const boundInScene = inScene.filter((e: any) => e.customData?.page !== undefined);
  const freeInScene  = inScene.filter((e: any) => e.customData?.page === undefined);
  const allBound = [...boundInScene, ...strokeStash];

  // 2. decide visible vs hidden
  const visible: any[] = [];
  const hidden: any[] = [];
  for (const e of allBound) {
    const shouldShow = doc.mode === "full" || doc.mode === "scroll" || e.customData.page === doc.currentPage;
    (shouldShow ? visible : hidden).push(e);
  }

  // 3. reposition visible strokes to their page's current position (slot in page-mode)
  const repositioned = visible.map((e: any) => {
    const p = pageById.get(e.customData.page);
    if (!p) return e;
    return { ...e, x: doc.origin.x + e.customData.pageX, y: p.bandTop + e.customData.pageY };
  });

  strokeStash = hidden;   // stash the rest
  // scene = free strokes + visible bound strokes (hidden ones are OUT)
  api.updateScene({ elements: [...freeInScene, ...repositioned] });
}

// ---- Single reassigned padding handle ----
let padHandle: HTMLDivElement | null = null;
let padHandleTarget: { page: LaidPage; side: "top" | "bottom" | "left" | "right" } | null = null;
let padDragging = false;

function ensurePadHandle() {
  if (padHandle) return padHandle;
  const h = document.createElement("div");
  h.id = "pad-handle";
  h.style.cssText =
    "position:fixed; z-index:160; background:#e8873a; border-radius:3px; " +
    "pointer-events:auto; display:none; box-shadow:0 1px 4px rgba(0,0,0,.3);";
  document.body.appendChild(h);
  h.addEventListener("pointerdown", startPadDrag);
  padHandle = h;
  return h;
}

function hidePadHandle() {
  if (padHandle && !padDragging) { padHandle.style.display = "none"; padHandleTarget = null; }
}

// find nearest inside-edge under the pointer, show/position the handle there
// show handles for the page(s) near the pointer; top/bottom inset inward
const INSET = 16; // screen px inset for top/bottom handles

function updatePadHandle(clientX: number, clientY: number) {
  if (!pdfDoc || padDragging) return;
  const doc = pdfDoc;
  const st = (window as any).notesAPI.getAppState();
  const z = st.zoom.value;
  const wx = clientX / z - st.scrollX;
  const wy = clientY / z - st.scrollY;
  const bandPx = 24 / z;
  const insetW = INSET / z;

  const pages = doc.mode === "page"
    ? doc.pages.filter(p => p.index === doc.currentPage)
    : doc.pages;

  // gather candidate (page, side, world edge position) with the handle INSET inward
  let best: { p: LaidPage; side: "top"|"bottom"|"left"|"right"; dist: number } | null = null;
  for (const p of pages) {
    const left = doc.origin.x - p.pdfW / 2 - p.padLeft;
    const right = doc.origin.x + p.pdfW / 2 + p.padRight;
    if (wx < left - bandPx || wx > right + bandPx) continue;
    if (wy < p.bandTop - bandPx || wy > p.bandBottom + bandPx) continue;

    // top/bottom handle sit INSET inward from the band edge
    const topHandleY = p.bandTop + insetW;
    const botHandleY = p.bandBottom - insetW;
    const cand: Array<["top"|"bottom"|"left"|"right", number, number, number]> = [
      ["top",    doc.origin.x, topHandleY, Math.hypot(wx - doc.origin.x, wy - topHandleY)],
      ["bottom", doc.origin.x, botHandleY, Math.hypot(wx - doc.origin.x, wy - botHandleY)],
      ["left",   left,  (p.pdfTop+p.pdfBottom)/2, Math.abs(wx - left) + (wy < p.bandTop || wy > p.bandBottom ? 1e9 : 0)],
      ["right",  right, (p.pdfTop+p.pdfBottom)/2, Math.abs(wx - right) + (wy < p.bandTop || wy > p.bandBottom ? 1e9 : 0)],
    ];
    for (const [side, , , dist] of cand) {
      if (dist < bandPx && (!best || dist < best.dist)) best = { p, side, dist };
    }
  }

  if (best) showPadHandleAt(doc, best.p, best.side, z, st);
  else hidePadHandle();
}

function showPadHandleAt(doc: PdfDoc, p: LaidPage, side: string, z: number, st: any) {
  const h = ensurePadHandle();
  padHandleTarget = { page: p, side: side as any };
  const left = doc.origin.x - p.pdfW / 2 - p.padLeft;
  const right = doc.origin.x + p.pdfW / 2 + p.padRight;
  const cx = doc.origin.x;
  const cy = (p.pdfTop + p.pdfBottom) / 2;
  const thick = 6, long = 40;
  const insetW = 16 / z;

  let worldX: number, worldY: number, w: number, hh: number;
  if (side === "top")    { worldX = cx; worldY = p.bandTop + insetW;    w = long; hh = thick; }
  else if (side === "bottom") { worldX = cx; worldY = p.bandBottom - insetW; w = long; hh = thick; }
  else if (side === "left")   { worldX = left;  worldY = cy; w = thick; hh = long; }
  else                        { worldX = right; worldY = cy; w = thick; hh = long; }

  const sx = (worldX + st.scrollX) * z;
  const sy = (worldY + st.scrollY) * z;
  h.style.display = "";
  h.style.width = w + "px";
  h.style.height = hh + "px";
  h.style.left = (sx - w / 2) + "px";
  h.style.top = (sy - hh / 2) + "px";
  h.style.cursor = (side === "left" || side === "right") ? "ew-resize" : "ns-resize";
}

function startPadDrag(e: PointerEvent) {
  if (!pdfDoc || !padHandleTarget) return;
  e.preventDefault(); e.stopPropagation();
  padDragging = true;
  const doc = pdfDoc;
  const { page, side } = padHandleTarget;
  const startPad = { top: page.padTop, bottom: page.padBottom, left: page.padLeft, right: page.padRight };
  const z = (window as any).notesAPI.getAppState().zoom.value;
  const sx = e.clientX, sy = e.clientY;

  const shield = document.createElement("div");
  shield.style.cssText = "position:fixed; inset:0; z-index:9999;";
  document.body.appendChild(shield);

  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / z;
    const dy = (ev.clientY - sy) / z;
    // dragging outward grows the padding on that side
    if (side === "top") {
      const isFirst = page.index === Math.min(...doc.pages.map(p => p.index));
      page.padTop = Math.max(0, isFirst ? startPad.top - dy : startPad.top + dy);
    }
    if (side === "bottom") page.padBottom = Math.max(0, startPad.bottom + dy); // down = grow
    if (side === "left")   page.padLeft   = Math.max(0, startPad.left - dx);   // left = grow
    if (side === "right")  page.padRight  = Math.max(0, startPad.right + dx);  // right = grow
    layoutPages(doc);
    computeBox(doc);
    syncBox();
    doc.rerender();
    // keep the handle glued to the moving edge
    const st = (window as any).notesAPI.getAppState();
    showPadHandleAt(doc, page, side, st.zoom.value, st);
  };
  const up = (ev: PointerEvent) => {
    padDragging = false;
    shield.removeEventListener("pointermove", move);
    shield.removeEventListener("pointerup", up);
    shield.remove();
  };
  shield.addEventListener("pointermove", move);
  shield.addEventListener("pointerup", up);
  shield.setPointerCapture(e.pointerId);
}

let sepLayer: HTMLDivElement | null = null;

function drawSeparators(doc: PdfDoc) {
  if (!doc.sepEl) {
    doc.sepEl = document.createElement("div");
    doc.sepEl.style.cssText = "position:fixed; inset:0; z-index:149; pointer-events:none; overflow:hidden;";
    document.body.appendChild(doc.sepEl);
  }
  const sep = doc.sepEl;
  sep.innerHTML = "";
  const st = (window as any).notesAPI.getAppState();
  const z = st.zoom.value;

  if (doc.mode === "full") {
    const left = doc.origin.x - Math.max(...doc.pages.map(p => p.pdfW)) / 2 - Math.max(...doc.pages.map(p => p.padLeft));
    const right = doc.origin.x + Math.max(...doc.pages.map(p => p.pdfW)) / 2 + Math.max(...doc.pages.map(p => p.padRight));
    const sxL = (left + st.scrollX) * z;
    const sxR = (right + st.scrollX) * z;
    for (let i = 0; i < doc.pages.length - 1; i++) {
      const sy = (doc.pages[i].bandBottom + st.scrollY) * z;
      const line = document.createElement("div");
      line.style.cssText = `position:absolute; left:${sxL}px; width:${sxR - sxL}px; top:${sy}px; border-top:2px dashed #999; opacity:0.6;`;
      sep.appendChild(line);
    }
  }

  const outlinePages = doc.mode === "page" ? doc.pages.filter(p => p.index === doc.currentPage) : doc.pages;
  for (const p of outlinePages) {
    const pl = (doc.origin.x - p.pdfW / 2 - p.padLeft + st.scrollX) * z;
    const pt = (p.bandTop + st.scrollY) * z;
    const pw = (p.pdfW + p.padLeft + p.padRight) * z;
    const ph = (p.bandBottom - p.bandTop) * z;
    const outline = document.createElement("div");
    outline.style.cssText = `position:absolute; left:${pl}px; top:${pt}px; width:${pw}px; height:${ph}px; border:1px solid rgba(120,120,120,0.25); pointer-events:none;`;
    sep.appendChild(outline);
  }
}

function applyScrollClip() {
  for (const doc of pdfDocs) 
  {
    if (!doc.el) return;
    if (doc.mode !== "scroll" || !doc.scrollWindow) {
      doc.el.style.clipPath = "";   // no clip in other modes
      return;
    }
    const st = (window as any).notesAPI.getAppState();
    const z = st.zoom.value;
    const w = doc.scrollWindow;
    const sx = (w.x + st.scrollX) * z;
    const sy = (w.y + st.scrollY) * z;
    const sw = w.w * z, sh = w.h * z;
    // clip the pdf-layer to the window's screen rect
    doc.el.style.clipPath = `inset(${sy}px calc(100% - ${sx + sw}px) calc(100% - ${sy + sh}px) ${sx}px)`;
  }
}

function applyScrollInk(doc: PdfDoc) {
  if (doc.mode !== "scroll" || !doc.scrollWindow) return;
  const api = (window as any).notesAPI;
  const off = doc.scrollOffset || 0;
  const w = doc.scrollWindow;
  const pageById = new Map(doc.pages.map(p => [p.index, p]));

  const inScene = api.getSceneElements();
  const bound = inScene.filter((e: any) => e.customData?.page !== undefined);
  const free  = inScene.filter((e: any) => e.customData?.page === undefined);
  const pool = [...bound, ...strokeStash];

  const visible: any[] = [];
  const hidden: any[] = [];
  for (const e of pool) {
    const p = pageById.get(e.customData.page);
    if (!p) { hidden.push(e); continue; }
    // stroke's scroll-mode world position (shifted up by offset, like the PDF)
    const wy = p.bandTop + e.customData.pageY - off;
    const wx = doc.origin.x + e.customData.pageX;
    // visible only if within the window's world Y-range (rough: use stroke top)
    const inWindow = wy >= w.y && wy <= w.y + w.h;
    if (inWindow) {
      visible.push({ ...e, x: wx, y: wy });
    } else {
      hidden.push(e);
    }
  }
  strokeStash = hidden;
  api.updateScene({ elements: [...free, ...visible] });
}

// ---- Stroke finalize: pressure remap + rounding + thinning ----
const PRESSURE_IN_MAX = 0.9;   // p / 1 = p (no change)  -------  your measured real max press → maps to full width
const PRESSURE_FLOOR = 0;    // no floor   --------   min width even at ~0 press (set 0 for pure taper)
const COORD_DECIMALS = 2;    // effectively no rounding  -------  2 = sub-pixel even at 3000% zoom
const THIN_DIST = 0.5;         // no thinning  ------  min world-distance between kept points (0 = no thinning)

function remapPressure(p: number): number {
  const stretched = Math.min(1, p / Math.max(0.01, PRESSURE_IN_MAX));
  return PRESSURE_FLOOR + stretched * (1 - PRESSURE_FLOOR);
}
const r = (n: number) => {
  const f = Math.pow(10, COORD_DECIMALS);
  return Math.round(n * f) / f;
};

function compactStroke(points: any[], pressures: any[] | undefined) {
  const outPts: any[] = [];
  const outPr: number[] = [];
  let lastKept: any = null;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const keep =
      i === 0 || i === points.length - 1 ||
      !lastKept ||
      Math.hypot(pt[0] - lastKept[0], pt[1] - lastKept[1]) >= THIN_DIST;
    if (!keep) continue;
    outPts.push([r(pt[0]), r(pt[1])]);
    if (pressures && pressures.length) {
      outPr.push(r(pressures[i] ?? 0));   // round only — NO remap
    }
    lastKept = pt;
  }
  return { points: outPts, pressures: (pressures && pressures.length) ? outPr : pressures };
}
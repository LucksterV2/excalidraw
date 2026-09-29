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
  const scene = {
    elements: api.getSceneElements(),
    appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
  };
  const res = await fetch(API_BASE + "/save.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, json: JSON.stringify(scene) }),
  });
  return res.json();
}

async function loadNote(name: string) {
  const api = (window as any).notesAPI;
  const res = await fetch(API_BASE + "/load.php?name=" + encodeURIComponent(name));
  if (!res.ok) throw new Error("load failed: " + res.status);
  const scene = await res.json();
  api.updateScene({
    elements: scene.elements,
    appState: { ...api.getAppState(), ...scene.appState },
  });
  try {
    api.setViewport({ target: api.getSceneElements(), fit: "scale-down", animation: false });
  } catch (e) {
    console.warn("setViewport skipped:", e);
  }
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
        item.textContent = row.name;
        item.addEventListener("click", async () => {
          try { await loadNote(row.name); currentName = row.name; toast("loaded ✓"); close(); }
          catch { toast("load failed"); }
        });
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

  const toggleBtn = panel.querySelector("#np-toggle") as HTMLButtonElement;
  toggleBtn.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("np-collapsed");
    toggleBtn.textContent = collapsed ? "‹" : "›";
  });

  (window as any).openNotePopup = openNotePopup;

  // detect clicks on linked strokes
  const mainApi = (window as any).notesAPI;
  if (mainApi?.onPointerUp) {
        mainApi.onPointerUp((activeTool: any, _state: any, _event: any) => {
      const appState = mainApi.getAppState();
      const selectedIds = Object.keys(appState.selectedElementIds || {});
      if (selectedIds.length !== 1) return; // only act on a single selected stroke
      const el = mainApi.getSceneElements().find((e: any) => e.id === selectedIds[0]);
      const link = el?.customData?.noteLink;
      if (link) {
        (window as any).openNotePopup?.(link.note, link.ids || []);
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
      if (now - lastRenderTime > 100) {   // throttle: render at most every 100ms while scrolling
        lastRenderTime = now;
        pdfDoc?.rerender();
      }
      scheduleSharpen();  // final crisp pass after stopping
    });
  }

  //(window as any).mountPdfLayer = mountPdf;
  (window as any).loadPdf = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/pdf";
    inp.onchange = () => inp.files && mountPdf(inp.files[0]).catch(e => console.error("PDF mount failed:", e));
    inp.click();
  };

  (window as any).setPagePad = (pageIndex: number, top: number, bottom: number) => {
    if (!pdfDoc) return;
    const p = pdfDoc.pages.find(pp => pp.index === pageIndex);
    if (!p) return;
    p.padTop = top; p.padBottom = bottom;
    layoutPages(pdfDoc.pages);       // recompute all bands (cascade)
    pdfDoc.rerender();               // re-render at new positions
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
// ---- Crisp PDF underlay ----
type PdfLayer = {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  pdf: any;
  pageNum: number;
  pageW: number;
  pageH: number;
  rerender: () => Promise<void>;
  _patch?: { wx: number; wy: number; ww: number; wh: number; scale: number };
};

let pdfLayer: PdfLayer | null = null;

// ---- Multi-page crisp PDF underlay ----
type PageGeom = {
  pdfW: number; pdfH: number;
  padTop: number; padBottom: number;
};
type LaidPage = PageGeom & {
  index: number;
  bandTop: number; pdfTop: number; pdfBottom: number; bandBottom: number;
  canvas: HTMLCanvasElement;
  _patch?: { wx: number; wy: number; ww: number; wh: number; scale: number };
};
type PdfDoc = {
  el: HTMLDivElement;
  pdf: any;
  pages: LaidPage[];
  padWidth: number;
  box: { x: number; y: number; w: number; h: number };
  boxEl?: HTMLDivElement;
  rerender: () => Promise<void>;
};

let pdfDoc: PdfDoc | null = null;

// Recompute each page's world-space band from paddings (the cascade).
function layoutPages(pages: LaidPage[]) {
  let y = 0;
  for (const p of pages) {
    p.bandTop = y;
    p.pdfTop = y + p.padTop;
    p.pdfBottom = p.pdfTop + p.pdfH;
    p.bandBottom = p.pdfBottom + p.padBottom;
    y = p.bandBottom;
  }
}

async function mountPdf(file: File) {
  if (pdfDoc) { pdfDoc.el.remove(); pdfDoc = null; }

  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

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
      bandTop: 0, pdfTop: 0, pdfBottom: 0, bandBottom: 0,
      canvas,
    });
  }
  layoutPages(pages);

  const fullW = Math.max(...pages.map(p => p.pdfW));
  const fullH = pages[pages.length - 1].bandBottom;
  const doc: PdfDoc = {
    el, pdf, pages, padWidth: 0,
    box: { x: 0, y: 0, w: fullW, h: fullH },
    rerender: async () => {},
  };
  pdfDoc = doc;
  createBox(doc);

  // render one page's visible slice (reuses your proven single-page logic)
  const renderPage = async (p: LaidPage, zoom: number, scrollX: number, scrollY: number) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    // visible world rect
    const worldLeft = -scrollX, worldTop = -scrollY;
    const worldRight = vw / zoom - scrollX, worldBottom = vh / zoom - scrollY;
    const mX = (worldRight - worldLeft) * 0.5, mY = (worldBottom - worldTop) * 0.5;

    // clip to THIS page's PDF rect (content sits at pdfTop..pdfBottom, x 0..pdfW)
    const renderScale = zoom;
    const g = 1 / renderScale;
    const wx = Math.max(0, Math.floor((worldLeft - mX) / g) * g);
    const wy = Math.max(p.pdfTop, Math.floor((worldTop - mY) / g) * g);
    const wxr = Math.min(p.pdfW, worldRight + mX);
    const wyb = Math.min(p.pdfBottom, worldBottom + mY);
    const ww = wxr - wx, wh = wyb - wy;

    if (ww <= 0 || wh <= 0) { p.canvas.style.display = "none"; return; } // page off-screen
    p.canvas.style.display = "";

    // skip if unchanged
    const sizeTol = Math.max(ww, wh) * 0.1; // 10% extent change before re-render
    if (p._patch && p.canvas.style.display !== "none" &&
        Math.abs(p._patch.wx - wx) < g &&
        Math.abs(p._patch.wy - wy) < g &&
        Math.abs(p._patch.ww - ww) < sizeTol &&
        Math.abs(p._patch.wh - wh) < sizeTol &&
        Math.abs(p._patch.scale - renderScale) / renderScale < 0.02) return;

    const page = await doc.pdf.getPage(p.index);
    const vp = page.getViewport({
      scale: renderScale,
      offsetX: -Math.round(wx * renderScale),
      offsetY: -Math.round((wy - p.pdfTop) * renderScale),
    });

    const pxW = Math.ceil(ww * renderScale);
    const pxH = Math.ceil(wh * renderScale);

    // render into an OFFSCREEN canvas first (never shows a blank frame)
    const off = document.createElement("canvas");
    off.width = pxW;
    off.height = pxH;
    const offCtx = off.getContext("2d")!;
    await page.render({ canvas: off, canvasContext: offCtx, viewport: vp } as any).promise;

    // now swap the finished pixels onto the visible canvas in one shot
    p.canvas.width = pxW;
    p.canvas.height = pxH;
    p.canvas.style.width = (pxW / renderScale) + "px";
    p.canvas.style.height = (pxH / renderScale) + "px";
    const ctx = p.canvas.getContext("2d")!;
    ctx.drawImage(off, 0, 0);
    p._patch = { wx, wy, ww, wh, scale: renderScale };

    // position THIS canvas immediately, same frame as the content swap
    const st2 = (window as any).notesAPI.getAppState();
    const z = st2.zoom.value;
    const sx = Math.round((wx + st2.scrollX) * z);
    const sy = Math.round((wy + st2.scrollY) * z);
    p.canvas.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
  };

  doc.rerender = async () => {
    const st = (window as any).notesAPI.getAppState();
    const zoom = st.zoom.value;
    for (const p of doc.pages) {
      await renderPage(p, zoom, st.scrollX, st.scrollY);
    }
    syncPdf();
  };

  await doc.rerender();
  syncPdf();
  (window as any).notesAPI.updateScene({ appState: { viewBackgroundColor: "transparent" } });
}

// position every page canvas to match Excalidraw pan/zoom
function syncPdf() {
  if (!pdfDoc) return;
  const st = (window as any).notesAPI.getAppState();
  const zoom = st.zoom.value;
  for (const p of pdfDoc.pages) {
    if (!p._patch) continue;
    const sx = Math.round((p._patch.wx + st.scrollX) * zoom);
    const sy = Math.round((p._patch.wy + st.scrollY) * zoom);
    p.canvas.style.transform = `translate(${sx}px, ${sy}px) scale(${zoom})`;
  }
}

// debounced crispen after motion stops
let sharpenTimer: any;
function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(async () => { await pdfDoc?.rerender(); }, 200);
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

  // 4 corner handles (resize)
  const corners: Array<[string, "nw"|"ne"|"sw"|"se"]> = [
    ["left:-7px;top:-7px;cursor:nwse-resize;", "nw"],
    ["right:-7px;top:-7px;cursor:nesw-resize;", "ne"],
    ["left:-7px;bottom:-7px;cursor:nesw-resize;", "sw"],
    ["right:-7px;bottom:-7px;cursor:nwse-resize;", "se"],
  ];
  for (const [css, which] of corners) {
    const h = document.createElement("div");
    h.style.cssText =
      `position:absolute; width:${HANDLE}px; height:${HANDLE}px; ` +
      "background:#4a90d9; border-radius:3px; pointer-events:auto; " + css;
    box.appendChild(h);
    attachResize(h, doc, which);
  }

  document.body.appendChild(box);
  doc.boxEl = box;
  syncBox();
}

// position + size the box div to match world coords through the canvas transform
function syncBox() {
  if (!pdfDoc?.boxEl) return;
  const st = (window as any).notesAPI.getAppState();
  const z = st.zoom.value;
  const b = pdfDoc.box;
  const sx = (b.x + st.scrollX) * z;
  const sy = (b.y + st.scrollY) * z;
  pdfDoc.boxEl.style.left = sx + "px";
  pdfDoc.boxEl.style.top = sy + "px";
  pdfDoc.boxEl.style.width = b.w * z + "px";
  pdfDoc.boxEl.style.height = b.h * z + "px";
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
    const start = { ...doc.box };  // capture ONCE at drag start
    dragWithShield((dx, dy) => {
      doc.box.x = start.x + dx;
      doc.box.y = start.y + dy;
      syncBox();
    })(e as PointerEvent);
  });
}

function attachResize(el: HTMLElement, doc: PdfDoc, which: "nw"|"ne"|"sw"|"se") {
  el.addEventListener("pointerdown", (e) => {
    const start = { ...doc.box };
    dragWithShield((dx, dy) => {
      let { x, y, w, h } = start;
      if (which === "se") { w = start.w + dx; h = start.h + dy; }
      if (which === "sw") { x = start.x + dx; w = start.w - dx; h = start.h + dy; }
      if (which === "ne") { y = start.y + dy; w = start.w + dx; h = start.h - dy; }
      if (which === "nw") { x = start.x + dx; y = start.y + dy; w = start.w - dx; h = start.h - dy; }
      doc.box.x = x; doc.box.y = y;
      doc.box.w = Math.max(20, w); doc.box.h = Math.max(20, h);
      syncBox();
    })(e);
  });
}
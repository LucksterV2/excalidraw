// fs-backend.ts
// Local filesystem backend that MIMICS the PHP endpoints via the File System Access API.
// It overrides window.fetch for API_BASE URLs and routes them to file operations in a
// user-granted vault folder. The rest of the app (notes-panel.ts) is unchanged.
//
// Vault layout:
//   notes/<name>.json                 (name's "/" -> real subfolders)
//   notes/<name>.json  (name ending __autosave is the autosave shadow)
//   pdfs/<hash>.pdf
//   images/<hash>                     (no extension; mime in index/images.json)
//   versions/<encoded name>/<ts>.json (ts = ms timestamp, also the version "id")
//   config/menu.json
//   index/tags.json                   { note: [{elementId, text}, ...] }
//   index/links.json                  { note: [{sourceElementId, targetNote}, ...] }
//   index/images.json                 { hash: mime }
//   index/docrefs.json                { hash: refcount }

const VERSION_KEEP = 20;
const AUTOSAVE_KEEP = 15;

let vaultDir: FileSystemDirectoryHandle | null = null;

// ---------- directory + file helpers ----------

async function getDir(path: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  if (!vaultDir) throw new Error("vault not opened");
  let dir = vaultDir;
  const parts = path.split("/").filter(Boolean);
  for (const p of parts) {
    try { dir = await dir.getDirectoryHandle(p, { create }); }
    catch { return null; }
  }
  return dir;
}

// Split "MATH1/Lecture 1" -> dir "notes/MATH1", file "Lecture 1.json"
function noteParts(name: string): { dirPath: string; file: string } {
  const segs = name.split("/");
  const file = segs.pop()!;
  const dirPath = ["notes", ...segs].join("/");
  return { dirPath, file: file + ".json" };
}

async function readFileText(dirPath: string, file: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const dir = await getDir(dirPath, false);
    if (!dir) return null;
    try {
      const fh = await dir.getFileHandle(file);
      const f = await fh.getFile();
      return await f.text();
    } catch (e: any) {
      if (e && e.name === "NotFoundError") return null;   // genuinely missing → don't retry
      await new Promise(r => setTimeout(r, 80 * (attempt + 1)));  // transient → wait + retry
    }
  }
  return null;
}

async function readFileBytes(dirPath: string, file: string): Promise<ArrayBuffer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const dir = await getDir(dirPath, false);
    if (!dir) return null;
    try {
      const fh = await dir.getFileHandle(file);
      const f = await fh.getFile();
      return await f.arrayBuffer();
    } catch (e: any) {
      if (e && e.name === "NotFoundError") return null;
      await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  return null;
}

async function fileModified(dirPath: string, file: string): Promise<number | null> {
  const dir = await getDir(dirPath, false);
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(file);
    const f = await fh.getFile();
    return f.lastModified;
  } catch { return null; }
}

async function writeFileText(dirPath: string, file: string, text: string): Promise<void> {
  const dir = await getDir(dirPath, true);
  if (!dir) throw new Error("cannot create " + dirPath);
  const fh = await dir.getFileHandle(file, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

async function writeFileBytes(dirPath: string, file: string, data: ArrayBuffer): Promise<void> {
  const dir = await getDir(dirPath, true);
  if (!dir) throw new Error("cannot create " + dirPath);
  const fh = await dir.getFileHandle(file, { create: true });
  const w = await fh.createWritable();
  await w.write(data as any);
  await w.close();
}

async function deleteFile(dirPath: string, file: string): Promise<void> {
  const dir = await getDir(dirPath, false);
  if (!dir) return;
  try { await dir.removeEntry(file); } catch {}
}

async function fileExists(dirPath: string, file: string): Promise<boolean> {
  const dir = await getDir(dirPath, false);
  if (!dir) return false;
  try { await dir.getFileHandle(file); return true; } catch { return false; }
}

// Recursively list all note names (relative to notes/, "/"-joined, without .json)
async function listNotes(): Promise<{ name: string; updated_at: string }[]> {
  const out: { name: string; updated_at: string }[] = [];
  const root = await getDir("notes", false);
  if (!root) return out;
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    // @ts-ignore - entries() exists on directory handles
    for await (const [name, handle] of (dir as any).entries()) {
      if (handle.kind === "directory") {
        await walk(handle, prefix + name + "/");
      } else if (name.endsWith(".json")) {
        const noteName = prefix + name.slice(0, -5);
        const f = await (handle as FileSystemFileHandle).getFile();
        out.push({ name: noteName, updated_at: new Date(f.lastModified).toISOString() });
      }
    }
  }
  await walk(root, "");
  return out;
}

// ---------- index helpers (tags / links / images / docrefs) ----------

async function readIndex(name: string): Promise<any> {
  const txt = await readFileText("index", name + ".json");
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return {}; }
}
async function writeIndex(name: string, obj: any): Promise<void> {
  await writeFileText("index", name + ".json", JSON.stringify(obj));
}

// ---------- versions ----------

// versions live under versions/<encoded name>/<ts>.json ; the "id" is the ts (ms).
function encodeVersionDir(name: string): string {
  // avoid nested dirs for version folders — encode "/" so it's one flat folder name
  return name.replace(/\//g, "__");
}
async function archiveVersion(name: string, oldJson: string): Promise<void> {
  if (name.endsWith("__autosave")) return;
  const ts = Date.now();
  const dirPath = "versions/" + encodeVersionDir(name);
  await writeFileText(dirPath, ts + ".json", oldJson);
  // prune to VERSION_KEEP newest
  const dir = await getDir(dirPath, false);
  if (!dir) return;
  const files: number[] = [];
  // @ts-ignore
  for await (const [fn, h] of (dir as any).entries()) {
    if (h.kind === "file" && fn.endsWith(".json")) files.push(parseInt(fn));
  }
  files.sort((a, b) => b - a); // newest first
  for (const old of files.slice(VERSION_KEEP)) {
    try { await dir.removeEntry(old + ".json"); } catch {}
  }
}
async function listVersions(name: string): Promise<{ id: number; saved_at: string; size: number }[]> {
  const dirPath = "versions/" + encodeVersionDir(name);
  const dir = await getDir(dirPath, false);
  if (!dir) return [];
  const rows: { id: number; saved_at: string; size: number }[] = [];
  // @ts-ignore
  for await (const [fn, h] of (dir as any).entries()) {
    if (h.kind === "file" && fn.endsWith(".json")) {
      const ts = parseInt(fn);
      const f = await (h as FileSystemFileHandle).getFile();
      rows.push({ id: ts, saved_at: new Date(ts).toISOString(), size: f.size });
    }
  }
  rows.sort((a, b) => b.id - a.id); // newest first
  return rows;
}
function baseNoteName(n: string): string {
  return n.endsWith("__autosave") ? n.slice(0, -"__autosave".length) : n;
}
async function snapshotAutosave(autosaveName: string, json: string): Promise<void> {
  const folder = "autosaves/" + baseNoteName(autosaveName).replace(/\//g, "__");
  const ts = Date.now();
  await writeFileText(folder, ts + ".json", json);
  const dir = await getDir(folder, false);
  if (!dir) return;
  const files: number[] = [];
  // @ts-ignore
  for await (const [fn, h] of (dir as any).entries()) {
    if (h.kind === "file" && fn.endsWith(".json")) files.push(parseInt(fn));
  }
  files.sort((a, b) => b - a);
  for (const old of files.slice(AUTOSAVE_KEEP)) {
    try { await dir.removeEntry(old + ".json"); } catch {}
  }
}
async function listAutosaves(baseName: string): Promise<{id:number;saved_at:string;size:number}[]> {
  const dir = await getDir("autosaves/" + baseName.replace(/\//g, "__"), false);
  if (!dir) return [];
  const rows: {id:number;saved_at:string;size:number}[] = [];
  // @ts-ignore
  for await (const [fn, h] of (dir as any).entries()) {
    if (h.kind === "file" && fn.endsWith(".json")) {
      const ts = parseInt(fn);
      const f = await (h as FileSystemFileHandle).getFile();
      rows.push({ id: ts, saved_at: new Date(ts).toISOString(), size: f.size });
    }
  }
  rows.sort((a,b)=>b.id-a.id);
  return rows;
}
async function getAutosave(baseName: string, id: number) {
  const txt = await readFileText("autosaves/" + baseName.replace(/\//g, "__"), id + ".json");
  if (txt === null) return null;
  return { id, name: baseName, json: txt, saved_at: new Date(id).toISOString() };
}
async function handleAutosaves(params: URLSearchParams): Promise<Response> {
  const name = (params.get("name") || "").trim();
  if (!name) return jsonResponse({ error: "name" }, 400);
  if (params.has("id")) {
    const row = await getAutosave(name, parseInt(params.get("id")!));
    if (!row) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(row);
  }
  return jsonResponse(await listAutosaves(name));
}
async function getVersion(id: number): Promise<{ id: number; name: string; json: string; saved_at: string } | null> {
  // id is a ts; we must find which note folder holds it. Scan version folders.
  const vroot = await getDir("versions", false);
  if (!vroot) return null;
  // @ts-ignore
  for await (const [folder, h] of (vroot as any).entries()) {
    if (h.kind !== "directory") continue;
    try {
      const fh = await (h as FileSystemDirectoryHandle).getFileHandle(id + ".json");
      const f = await fh.getFile();
      const json = await f.text();
      const name = folder.replace(/__/g, "/");
      return { id, name, json, saved_at: new Date(id).toISOString() };
    } catch { /* not in this folder */ }
  }
  return null;
}

// ---------- hashing (match PHP sha256 hex) ----------

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- the endpoint handlers ----------
// Each returns a Response (so the mimic can hand it back from fetch()).

function jsonResponse(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function rawJsonResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}
function binaryResponse(data: ArrayBuffer, mime: string, status = 200): Response {
  return new Response(data, { status, headers: { "Content-Type": mime } });
}

async function handleSave(body: any): Promise<Response> {
  const name = (body.name || "").trim();
  const json = body.json || "";
  if (!name || !json) return jsonResponse({ error: "name and json required" }, 400);
  const { dirPath, file } = noteParts(name);
  // archive current before overwrite (non-autosave only)
    if (!name.endsWith("__autosave")) {
    const old = await readFileText(dirPath, file);
    if (old) await archiveVersion(name, old);
  } else {
    await snapshotAutosave(name, json);
  }
  await writeFileText(dirPath, file, json);
  return jsonResponse({ ok: true, name, updated_at: new Date().toISOString() });
}

async function handleLoad(name: string): Promise<Response> {
  name = (name || "").trim();
  if (!name) return jsonResponse({ error: "name required" }, 400);
  const { dirPath, file } = noteParts(name);
  const txt = await readFileText(dirPath, file);
  if (txt === null) return jsonResponse({ error: "not found" }, 404);
  return rawJsonResponse(txt); // raw scene JSON, like load.php
}

async function handleSearch(q: string): Promise<Response> {
  q = (q || "").trim();
  let rows = await listNotes();
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q.toLowerCase()));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse(rows);
}

async function handleTagSave(body: any): Promise<Response> {
  const note = (body.note || "").trim();
  const tags = body.tags || [];
  if (!note) return jsonResponse({ error: "note" }, 400);
  const idx = await readIndex("tags");
  idx[note] = tags;                 // replace this note's entry
  await writeIndex("tags", idx);
  return jsonResponse({ ok: true, count: tags.length });
}

async function handleTagSearch(q: string): Promise<Response> {
  q = (q || "").trim();
  if (!q) return jsonResponse([]);
  const idx = await readIndex("tags");
  const out: any[] = [];
  for (const note of Object.keys(idx)) {
    if (note.endsWith("__autosave")) continue;
    for (const t of idx[note]) {
      if ((t.text || "").toLowerCase().includes(q.toLowerCase())) {
        out.push({ note, elementId: t.elementId || "", text: t.text || "" });
      }
    }
  }
  out.sort((a, b) => a.note.localeCompare(b.note));
  return jsonResponse(out);
}

async function handleLinkSave(body: any): Promise<Response> {
  const note = (body.note || "").trim();
  const links = body.links || [];
  if (!note) return jsonResponse({ error: "note" }, 400);
  const idx = await readIndex("links");
  idx[note] = links;
  await writeIndex("links", idx);
  return jsonResponse({ ok: true, count: links.length });
}

async function handleRename(oldName: string, newName: string): Promise<Response> {
  oldName = (oldName || "").trim(); newName = (newName || "").trim();
  if (!oldName || !newName) return jsonResponse({ error: "old/new" }, 400);

  // inbound: which notes link TO oldName (from links index)
  const linksIdx = await readIndex("links");
  const inbound: string[] = [];
  for (const src of Object.keys(linksIdx)) {
    if ((linksIdx[src] || []).some((l: any) => l.targetNote === oldName)) inbound.push(src);
  }

  // move the note file
  const o = noteParts(oldName), n = noteParts(newName);
  const content = await readFileText(o.dirPath, o.file);
  if (content !== null) {
    await writeFileText(n.dirPath, n.file, content);
    await deleteFile(o.dirPath, o.file);
  }
  // move autosave shadow if present
  const oAuto = noteParts(oldName + "__autosave"), nAuto = noteParts(newName + "__autosave");
  const autoContent = await readFileText(oAuto.dirPath, oAuto.file);
  if (autoContent !== null) {
    await writeFileText(nAuto.dirPath, nAuto.file, autoContent);
    await deleteFile(oAuto.dirPath, oAuto.file);
  }

  // move tags entry
  const tagsIdx = await readIndex("tags");
  if (tagsIdx[oldName]) { tagsIdx[newName] = tagsIdx[oldName]; delete tagsIdx[oldName]; await writeIndex("tags", tagsIdx); }
  // fix links index both directions
  if (linksIdx[oldName]) { linksIdx[newName] = linksIdx[oldName]; delete linksIdx[oldName]; }
  for (const src of Object.keys(linksIdx)) {
    for (const l of linksIdx[src]) if (l.targetNote === oldName) l.targetNote = newName;
  }
  await writeIndex("links", linksIdx);

  return jsonResponse({ ok: true, inbound });
}

async function handleNoteDelete(name: string): Promise<Response> {
  name = (name || "").trim();
  if (!name) return jsonResponse({ error: "name" }, 400);
  const { dirPath, file } = noteParts(name);
  await deleteFile(dirPath, file);
  return jsonResponse({ ok: true });
}

async function handleMenuConfig(method: string, body?: string): Promise<Response> {
  if (method === "POST") {
    await writeFileText("config", "menu.json", body || "null");
    return jsonResponse({ ok: true });
  }
  const txt = await readFileText("config", "menu.json");
  return rawJsonResponse(txt ?? "null");
}

async function handleImgSave(data: ArrayBuffer, mime: string): Promise<Response> {
  if (!data || data.byteLength < 50) return jsonResponse({ error: "no image" }, 400);
  const hash = await sha256Hex(data);
  if (!(await fileExists("images", hash))) {
    await writeFileBytes("images", hash, data);
    const idx = await readIndex("images");
    idx[hash] = mime || "image/png";
    await writeIndex("images", idx);
  }
  return jsonResponse({ ok: true, hash });
}

async function handleImgLoad(hash: string): Promise<Response> {
  hash = (hash || "").replace(/[^a-f0-9]/g, "");
  const data = await readFileBytes("images", hash);
  if (!data) return new Response(null, { status: 404 });
  const idx = await readIndex("images");
  return binaryResponse(data, idx[hash] || "image/png");
}

async function handleDocSave(data: ArrayBuffer): Promise<Response> {
  if (!data || data.byteLength < 100) return jsonResponse({ error: "no pdf" }, 400);
  const hash = await sha256Hex(data);
  if (!(await fileExists("pdfs", hash + ".pdf"))) {
    await writeFileBytes("pdfs", hash + ".pdf", data);
    const refs = await readIndex("docrefs");
    if (!(hash in refs)) { refs[hash] = 0; await writeIndex("docrefs", refs); }
  }
  return jsonResponse({ ok: true, hash });
}

async function handleDocLoad(hash: string): Promise<Response> {
  hash = (hash || "").replace(/[^a-f0-9]/g, "");
  const data = await readFileBytes("pdfs", hash + ".pdf");
  if (!data) return new Response(null, { status: 404 });
  return binaryResponse(data, "application/pdf");
}

async function handleDocRef(hash: string): Promise<Response> {
  hash = (hash || "").replace(/[^a-f0-9]/g, "");
  if (!hash) return jsonResponse({ error: "hash" }, 400);
  const refs = await readIndex("docrefs");
  refs[hash] = (refs[hash] || 0) + 1;
  await writeIndex("docrefs", refs);
  return jsonResponse({ ok: true });
}

async function handleDocDelete(hash: string): Promise<Response> {
  hash = (hash || "").replace(/[^a-f0-9]/g, "");
  if (!hash) return jsonResponse({ error: "hash" }, 400);
  await deleteFile("pdfs", hash + ".pdf");
  const refs = await readIndex("docrefs");
  delete refs[hash];
  await writeIndex("docrefs", refs);
  return jsonResponse({ ok: true });
}

async function handleVersions(params: URLSearchParams): Promise<Response> {
  if (params.has("id")) {
    const row = await getVersion(parseInt(params.get("id")!));
    if (!row) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(row);
  }
  const name = (params.get("name") || "").trim();
  if (!name) return jsonResponse({ error: "name" }, 400);
  return jsonResponse(await listVersions(name));
}

// ---------- the fetch router ----------

function pathOf(url: string): string {
  // strip API_BASE and query; return the .php filename
  try {
    const u = new URL(url, location.href);
    return u.pathname.split("/").pop() || "";
  } catch {
    return url.split("?")[0].split("/").pop() || "";
  }
}

async function routeRequest(url: string, init?: RequestInit): Promise<Response> {
  const file = pathOf(url);
  const u = new URL(url, location.href);
  const params = u.searchParams;
  const method = (init?.method || "GET").toUpperCase();

  // read body helpers
  const bodyText = async () => (init?.body ? (typeof init.body === "string" ? init.body : await new Response(init.body as any).text()) : "");
  const bodyJson = async () => { const t = await bodyText(); try { return JSON.parse(t); } catch { return {}; } };
  const bodyBytes = async () => (init?.body ? await new Response(init.body as any).arrayBuffer() : new ArrayBuffer(0));

  switch (file) {
    case "save.php":       return handleSave(await bodyJson());
    case "load.php":       return handleLoad(params.get("name") || "");
    case "search.php":     return handleSearch(params.get("q") || "");
    case "tagsave.php":    return handleTagSave(await bodyJson());
    case "tagsearch.php":  return handleTagSearch(params.get("q") || "");
    case "linksave.php":   return handleLinkSave(await bodyJson());
    case "rename.php":     return handleRename(params.get("old") || "", params.get("new") || "");
    case "notedelete.php": return handleNoteDelete(params.get("name") || "");
    case "menuconfig.php": return handleMenuConfig(method, method === "POST" ? await bodyText() : undefined);
    case "imgsave.php":    return handleImgSave(await bodyBytes(), (init?.headers as any)?.["Content-Type"] || "image/png");
    case "imgload.php":    return handleImgLoad(params.get("hash") || "");
    case "docsave.php":    return handleDocSave(await bodyBytes());
    case "docload.php":    return handleDocLoad(params.get("hash") || "");
    case "docref.php":     return handleDocRef(params.get("hash") || "");
    case "docdelete.php":  return handleDocDelete(params.get("hash") || "");
    case "versions.php":   return handleVersions(params);
    case "autosaves.php":  return handleAutosaves(params);
    default:
      return new Response(JSON.stringify({ error: "unknown endpoint: " + file }), { status: 404 });
  }
}

// ---------- public API: open the vault + install the fetch override ----------

const API_HOST_MARKER = "nodanio.dk"; // intercept any request to the old backend host

let originalFetch: typeof window.fetch;

export function installFsBackend() {
  let originalFetch: typeof window.fetch | undefined;
  originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input as Request).url);
    if (url.includes(API_HOST_MARKER) || /\/(save|load|search|tagsave|tagsearch|linksave|rename|notedelete|menuconfig|imgsave|imgload|docsave|docload|docref|docdelete|versions|autosaves)\.php/.test(url)) {
      if (!vaultDir) {
        return new Response(JSON.stringify({ error: "vault not opened" }), { status: 503 });
      }
      try { return await routeRequest(url, init); }
      catch (e: any) { return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 }); }
    }
    // EXAM-SAFE: block ALL other network requests so nothing can reach the network.
    // Set EXAM_SAFE = false if you ever want non-API requests to pass through normally.
    if (EXAM_SAFE) {
      console.warn("[fs-backend] blocked network request:", url);
      return new Response(JSON.stringify({ error: "network blocked (offline mode)" }), { status: 503 });
    }
    return originalFetch(input as any, init);
  };
}

// When true, any fetch that is NOT one of our mimicked endpoints is refused locally
// (never reaches the network). This is the exam-safe default. Flip to false during
// development if you ever need a real outbound request to pass through.
const EXAM_SAFE = true;

// Open (or re-open) the vault folder. Call this on a user gesture (button click).
export async function openVault(): Promise<string> {
  // try to reuse a stored handle first
  const stored = await loadStoredHandle();
  if (stored) {
    const perm = await (stored as any).queryPermission({ mode: "readwrite" });
    if (perm === "granted" || (await (stored as any).requestPermission({ mode: "readwrite" })) === "granted") {
      vaultDir = stored;
      return stored.name;
    }
  }
  // otherwise prompt
  // @ts-ignore
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });
  vaultDir = dir;
  await storeHandle(dir);
  return dir.name;
}

export function vaultIsOpen(): boolean { return !!vaultDir; }

// ---------- persist the directory handle in IndexedDB so grant is remembered ----------

const IDB_NAME = "notes-vault";
const IDB_STORE = "handles";

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function storeHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, "vault");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {}
}
async function loadStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const r = tx.objectStore(IDB_STORE).get("vault");
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}

// Rebuild the tags/links indexes by scanning every note (safety net / first migration).
export async function rebuildIndexes(): Promise<{ notes: number; tags: number; links: number }> {
  const tagsIdx: any = {}, linksIdx: any = {};
  const notes = await listNotes();
  let tagCount = 0, linkCount = 0;
  for (const { name } of notes) {
    if (name.endsWith("__autosave")) continue;
    const { dirPath, file } = noteParts(name);
    const txt = await readFileText(dirPath, file);
    if (!txt) continue;
    let scene: any;
    try { scene = JSON.parse(txt); } catch { continue; }
    const tags: any[] = [], links: any[] = [];
    for (const e of (scene.elements || [])) {
      const ts = e.customData?.tags;
      if (Array.isArray(ts)) for (const t of ts) { tags.push({ elementId: e.id, text: t }); tagCount++; }
      const nl = e.customData?.noteLink;
      if (nl?.note) { links.push({ sourceElementId: e.id, targetNote: nl.note }); linkCount++; }
    }
    if (tags.length) tagsIdx[name] = tags;
    if (links.length) linksIdx[name] = links;
  }
  await writeIndex("tags", tagsIdx);
  await writeIndex("links", linksIdx);
  return { notes: notes.length, tags: tagCount, links: linkCount };
}

#!/usr/bin/env node
// Profile sync for the ShardX Launcher: copies profiles (fingerprint + cookies,
// logins, local storage) and launcher config to a NAS or Google Drive folder,
// and back. Snapshot copies via rsync, never a live data root on the share:
// Chromium's SQLite files corrupt when a sync client touches them mid-write.
//
// Usage as CLI:
//   node sync.js status
//   node sync.js set <nas|gdrive> <folder>
//   node sync.js push <nas|gdrive> [profile_id]
//   node sync.js pull <nas|gdrive> [profile_id]
//   node sync.js auto <nas|gdrive|"">      (open = pull, close = push; launcher does the work)
//   node sync.js takeover <profile_id>      (drop a dead machine's lock)
//
// macOS / Linux only (needs rsync); the launcher's Settings panel covers Windows.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash, createHmac, randomUUID } from "node:crypto";

const HOME = os.homedir();
export const CONFIG_ROOT =
  process.platform === "darwin"
    ? path.join(HOME, "Library/Application Support/shardx-launcher")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "shardx-launcher")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "shardx-launcher");
const SYNC_CONF = path.join(CONFIG_ROOT, "sync.json");

const readJson = (p, d) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; }
};
const settings = () => readJson(path.join(CONFIG_ROOT, "settings.json"), {});
const dataRoot = () => settings().data_root || CONFIG_ROOT;

// API token minted from the launcher's own HS256 secret, so no copy/paste from
// Settings is needed. Same claims as api.rs `mint`.
export function localToken() {
  const s = settings();
  if (!s.api_secret) return "";
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "shardx-api", iat: now, exp: now + 3650 * 86400 })}`;
  return `${body}.${createHmac("sha256", s.api_secret).update(body).digest("base64url")}`;
}
export const localApi = () => `http://127.0.0.1:${settings().api_port || 40325}`;

function defaultTarget(name) {
  if (name === "gdrive") {
    const cs = path.join(HOME, "Library/CloudStorage");
    const g = fs.existsSync(cs) && fs.readdirSync(cs).find((d) => d.startsWith("GoogleDrive-"));
    if (g) return path.join(cs, g, "My Drive", "ShardX-Sync");
  }
  if (name === "nas" && fs.existsSync(path.join(HOME, "SynologyDrive"))) {
    return path.join(HOME, "SynologyDrive", "ShardX-Sync");
  }
  return null;
}

export function targets() {
  const conf = readJson(SYNC_CONF, {});
  return Object.fromEntries(
    ["nas", "gdrive"].map((n) => [n, conf[n] || process.env[`SHARDX_${n.toUpperCase()}_DIR`] || defaultTarget(n)]),
  );
}

export function setTarget(name, dir) {
  if (!["nas", "gdrive"].includes(name)) throw new Error("target must be nas or gdrive");
  const conf = readJson(SYNC_CONF, {});
  // Blank goes back to the detected default, same as the launcher's panel.
  if (!dir || !dir.trim()) delete conf[name];
  else conf[name] = path.resolve(dir.trim().replace(/^~(?=\/|$)/, HOME));
  fs.writeFileSync(SYNC_CONF, JSON.stringify(conf, null, 2));
  return targets();
}

// Folders whose children are mount points.
const MOUNT_ROOTS = ["/Volumes", "/mnt", "/media", "/run/media"];

function resolveTarget(name, mustExist) {
  const dir = targets()[name];
  if (!dir) throw new Error(`no folder set for "${name}". Run: set ${name} <folder> (e.g. /Volumes/<share>/ShardX-Sync)`);
  if (!path.isAbsolute(dir)) throw new Error(`${dir} is not an absolute path`);
  // Compared by file identity, not spelling: a symlink, other letter case,
  // a trailing slash or ".." must not slip a self-copy through.
  for (const local of [dataRoot(), CONFIG_ROOT]) {
    if (contains(local, dir) || contains(dir, local)) throw new Error(`${dir} overlaps the launcher's own data at ${local}`);
  }
  if (mustExist && !fs.existsSync(dir)) throw new Error(`${dir} not found (NAS not mounted, Drive not running, or nothing backed up yet)`);
  // Creating the folder under an unmounted share would write the backup onto
  // the local disk instead: refuse when the parent is missing, or when the
  // folder would be a mount point of its own (/Volumes/<share>).
  const parent = path.dirname(dir);
  if (!fs.existsSync(dir) && (!fs.existsSync(parent) || MOUNT_ROOTS.includes(parent))) {
    throw new Error(`${dir} not found (NAS not mounted / Drive not running?)`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Whether `inner` is `outer` or lies beneath it, asked of the file system.
function contains(outer, inner) {
  let o;
  try { o = fs.statSync(outer); } catch { return false; }
  for (let a = path.resolve(inner); ; a = path.dirname(a)) {
    try { const m = fs.statSync(a); if (m.dev === o.dev && m.ino === o.ino) return true; } catch {}
    if (path.dirname(a) === a) return false;
  }
}

// Profile ids are uuids; anything else never reaches a path, so an id like
// "../.." cannot point a mirror at the parent folder.
const ID = /^[0-9a-f-]{36}$/i;
function checkIds(ids) {
  const bad = ids.find((id) => !ID.test(id));
  if (bad !== undefined) throw new Error(`invalid profile id: ${bad}`);
}

// Chromium holds SingletonLock (a symlink to "<host>-<pid>") while the profile
// runs. A crash leaves it behind, so a dead pid does not count as running.
function running(udRoot, ids) {
  if (!fs.existsSync(udRoot)) return [];
  return (ids || fs.readdirSync(udRoot)).filter((id) => {
    let pid;
    try { pid = Number(fs.readlinkSync(path.join(udRoot, id, "SingletonLock")).split("-").pop()); } catch { return false; }
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  });
}

// Regenerated by Chromium; skipping them turns GBs into MBs. Same list as
// cloud_sync.rs skip(), in rsync's glob form and as regexes for manifest().
const SKIP_GLOBS = [
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache",
  "ShaderCache", "GraphiteDawnCache", "CacheStorage", "ScriptCache", "component_crx_cache",
  "Crashpad", "BrowserMetrics*", "Singleton*", "*.tmp", "LOCK",
];
const CACHE_EXCLUDES = SKIP_GLOBS.flatMap((p) => ["--exclude", p]);
const SKIP = SKIP_GLOBS.map((g) => new RegExp("^" + g.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$"));

function rsync(src, dst, extra = []) {
  fs.mkdirSync(dst, { recursive: true });
  execFileSync("rsync", ["-a", ...extra, ...CACHE_EXCLUDES, `${src}/`, `${dst}/`], { stdio: "pipe" });
}

const CONFIG_FILES = ["proxies.json", "proxies-history.json", "bookmarks.json", "automation.json", "psapi.json"];

// Config files travel whole, so: an empty file (a fresh install) never
// replaces a filled one, and a file about to be replaced is kept as
// <file>.<stamp>.bak first. Same rules as the launcher's panel.
// What the launcher writes when it holds nothing: {"proxies": []},
// {"by_proxy": {}}, {"api_key": ""}, or a bare empty value.
const emptyVal = (v) =>
  v === null || v === "" || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.values(v).every(emptyVal));
const isEmptyJson = (b) => {
  const t = b.toString("utf8").trim();
  if (!t) return true;
  try { return emptyVal(JSON.parse(t)); } catch { return false; }
};
function copyFiles(srcDir, dstDir, files) {
  fs.mkdirSync(dstDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
  for (const f of files) {
    const s = path.join(srcDir, f), d = path.join(dstDir, f);
    if (!fs.existsSync(s)) continue;
    const next = fs.readFileSync(s);
    const old = fs.existsSync(d) ? fs.readFileSync(d) : null;
    if (old && old.equals(next)) continue;
    if (old && !isEmptyJson(old)) {
      if (isEmptyJson(next)) continue;
      let bak = `${d}.${stamp}.bak`;
      for (let n = 1; fs.existsSync(bak); n++) bak = `${d}.${stamp}-${n}.bak`;
      fs.copyFileSync(d, bak);
    }
    fs.writeFileSync(d, next);
  }
}

function guardRunning(ids) {
  const busy = running(path.join(dataRoot(), "user-data"), ids);
  if (busy.length) throw new Error(`stop these running profiles first: ${busy.join(", ")}`);
}

const du = (p) => {
  try { return execFileSync("du", ["-sh", p], { encoding: "utf8" }).split("\t")[0]; } catch { return "?"; }
};

const idsIn = (dir) =>
  fs.existsSync(path.join(dir, "profiles"))
    ? fs.readdirSync(path.join(dir, "profiles")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
        .filter((id) => ID.test(id) && !readJson(path.join(dir, "profiles", `${id}.json`), {})._meta?.temporary)
    : [];

// One profile: its JSON plus an exact copy of its user-data dir. Mirroring
// inside the profile keeps SQLite's -journal/-wal files paired with their DB.
function copyProfile(from, to, id) {
  const json = path.join(from, "profiles", `${id}.json`);
  if (!fs.existsSync(json)) throw new Error(`profile ${id} not found in ${from}`);
  fs.mkdirSync(path.join(to, "profiles"), { recursive: true });
  fs.copyFileSync(json, path.join(to, "profiles", `${id}.json`));
  const ud = path.join(from, "user-data", id), dstUd = path.join(to, "user-data", id);
  if (fs.existsSync(ud)) rsync(ud, dstUd, ["--delete"]);
  // Never launched on the source side: no cookies to pair with the JSON.
  else fs.rmSync(dstUd, { recursive: true, force: true });
}

// ---------- Auto-sync protocol (shared with the launcher, cloud_sync.rs) ----------
// state/<id>.json {rev, machine, host, at, files} marks the newest upload;
// locks/<id>.json {machine, host, at} says which machine has the profile open.
// sync-state.json beside settings.json keeps the rev each profile was synced at.
const LOCK_STALE_SECS = 10 * 60;
const now = () => Math.floor(Date.now() / 1000);
const MACHINE_FILE = () => path.join(CONFIG_ROOT, "machine-id");
function machineId() {
  try { const m = fs.readFileSync(MACHINE_FILE(), "utf8").trim(); if (m) return m; } catch {}
  const id = randomUUID();
  fs.mkdirSync(CONFIG_ROOT, { recursive: true });
  fs.writeFileSync(MACHINE_FILE(), id);
  return id;
}
const LOCAL_STATE = () => path.join(CONFIG_ROOT, "sync-state.json");
// Keyed by folder, then profile: a rev only means something in its own folder.
// fp is the user-data fingerprint right after the last sync (see fingerprint()).
const getLocal = (dir, id) => readJson(LOCAL_STATE(), {})[dir]?.[id] || { rev: 0, dirty: false, fp: "" };
function setLocal(dir, id, e) {
  const all = readJson(LOCAL_STATE(), {});
  (all[dir] ||= {})[id] = e;
  writeJsonAtomic(LOCAL_STATE(), all);
}
function writeJsonAtomic(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".part", JSON.stringify(v, null, 2));
  fs.renameSync(p + ".part", p);
}
export const remoteState = (dir, id) => readJson(path.join(dir, "state", `${id}.json`), null);
export const remoteLock = (dir, id) => readJson(path.join(dir, "locks", `${id}.json`), null);
const foreignLock = (dir, id) => {
  const l = remoteLock(dir, id);
  return l && l.machine !== machineId() && now() - l.at < LOCK_STALE_SECS ? l : null;
};
// relative path -> [size, mtime secs], same walk as cloud_sync.rs scan().
function scan(dir) {
  const out = {};
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.some((re) => re.test(e.name))) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const st = fs.statSync(p); out[path.relative(dir, p).split(path.sep).join("/")] = [st.size, Math.floor(st.mtimeMs / 1000)]; }
    }
  };
  walk(dir);
  return out;
}
// FNV-1a 64 over "path\0size\0mtime\n" in sorted (byte) order; matches the launcher.
function fingerprint(dir) {
  const entries = Object.entries(scan(dir)).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  let h = 0xcbf29ce484222325n;
  for (const [k, [len, mt]] of entries) {
    for (const b of Buffer.from(`${k}\0${len}\0${mt}\n`)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  }
  return h.toString(16).padStart(16, "0");
}
// path -> {size, sha256}; the hash lets a reader tell a finished upload from a
// same-size stale SQLite file. Same shape as cloud_sync.rs FileSig::Full.
function manifest(dir) {
  const out = {};
  for (const [rel, [size]] of Object.entries(scan(dir))) {
    out[rel] = { size, sha256: createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex") };
  }
  return out;
}

// The folder holds work this machine has not seen (see remote_ahead in cloud_sync.rs).
// A state file that is there but does not parse (still downloading, damaged)
// is never read as "no state".
const stateUnreadable = (dir, id) => fs.existsSync(path.join(dir, "state", `${id}.json`)) && !remoteState(dir, id);
// Every listed file is there with its size and hash, and nothing unlisted.
function arrived(dir, id, st) {
  const ud = path.join(dir, "user-data", id);
  if (!fs.existsSync(path.join(dir, "profiles", `${id}.json`))) return false;
  const files = st.files || {};
  const full = Object.values(files).some((f) => typeof f === "object");
  if (full && Object.entries(scan(ud)).some(([rel, [size]]) => size > 0 && !(rel in files))) return false;
  return Object.entries(files).every(([rel, sig]) => {
    const p = path.join(ud, rel);
    const size = typeof sig === "object" ? sig.size : sig;
    if (!fs.existsSync(p) || fs.statSync(p).size !== size) return false;
    return typeof sig !== "object" || createHash("sha256").update(fs.readFileSync(p)).digest("hex") === sig.sha256;
  });
}
function remoteAhead(dir, id) {
  if (stateUnreadable(dir, id)) return true;
  const st = remoteState(dir, id), local = getLocal(dir, id);
  if (st) return st.rev > local.rev;
  const rud = path.join(dir, "user-data", id), lud = path.join(dataRoot(), "user-data", id);
  if (!Object.keys(scan(rud)).length || local.fp) return false;
  return fingerprint(lud) !== fingerprint(rud);
}
function publish(dst, id) {
  const root = dataRoot();
  copyProfile(root, dst, id);
  const rev = Math.max(remoteState(dst, id)?.rev || 0, getLocal(dst, id).rev) + 1;
  writeJsonAtomic(path.join(dst, "state", `${id}.json`), {
    rev, machine: machineId(), host: os.hostname(), at: now(), files: manifest(path.join(root, "user-data", id)),
  });
  setLocal(dst, id, { rev, dirty: false, fp: fingerprint(path.join(root, "user-data", id)) });
}
function adopt(src, id) {
  copyProfile(src, dataRoot(), id);
  setLocal(src, id, { rev: remoteState(src, id)?.rev || 0, dirty: false, fp: fingerprint(path.join(dataRoot(), "user-data", id)) });
}

export function setAuto(target) {
  if (target && !["nas", "gdrive"].includes(target)) throw new Error("target must be nas, gdrive or empty");
  const conf = readJson(SYNC_CONF, {});
  if (target) conf.auto = target; else delete conf.auto;
  fs.writeFileSync(SYNC_CONF, JSON.stringify(conf, null, 2));
  return { auto: conf.auto || null };
}

// For when the machine holding a lock died with it held.
export function takeOver(id) {
  checkIds([id]);
  const t = readJson(SYNC_CONF, {}).auto;
  if (!t) throw new Error("auto sync is off");
  const dir = resolveTarget(t, true);
  fs.rmSync(path.join(dir, "locks", `${id}.json`), { force: true });
  return { released: id };
}

// Never deletes a profile from the backup: a full push from a fresh machine
// must not wipe what other machines stored.
export function push(name, profileId) {
  const root = dataRoot();
  const ids = profileId ? [profileId] : idsIn(root);
  checkIds(ids);
  guardRunning(ids);
  const dst = resolveTarget(name, false);
  // Open or changed on another machine since this one last synced: theirs is
  // newer. Only an explicit one-profile backup overrides that.
  const skipped = ids.filter((id) => foreignLock(dst, id) || (!profileId && remoteAhead(dst, id)));
  if (profileId && skipped.length) throw new Error(`profile ${profileId} is open on ${foreignLock(dst, profileId).host}; back it up there`);
  for (const id of ids) if (!skipped.includes(id)) publish(dst, id);
  if (!profileId) {
    if (fs.existsSync(path.join(root, "extensions"))) rsync(path.join(root, "extensions"), path.join(dst, "extensions"));
    copyFiles(CONFIG_ROOT, path.join(dst, "config"), CONFIG_FILES);
  }
  fs.writeFileSync(path.join(dst, "LAST_PUSH.json"), JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), profile: profileId || "all" }));
  return { target: name, dir: dst, profiles: ids.length - skipped.length, skipped, size: du(dst) };
}

// Replaces each restored profile wholesale and keeps profiles that exist only
// here. A full pull also brings the config (see copyFiles).
export function pull(name, profileId) {
  const src = resolveTarget(name, true);
  const ids = profileId ? [profileId] : idsIn(src);
  checkIds(ids);
  guardRunning(ids);
  const root = dataRoot();
  // Open elsewhere or still uploading: restoring now would take a copy that is
  // about to change and record it as in sync.
  const skipped = ids.filter((id) => {
    const st = remoteState(src, id);
    return foreignLock(src, id) || stateUnreadable(src, id) || (st && !arrived(src, id, st));
  });
  if (profileId && skipped.length) throw new Error(`profile ${profileId} is open on another machine or still uploading; try again once it is closed there`);
  for (const id of ids) if (!skipped.includes(id)) adopt(src, id);
  if (!profileId) {
    if (fs.existsSync(path.join(src, "extensions"))) rsync(path.join(src, "extensions"), path.join(root, "extensions"));
    copyFiles(path.join(src, "config"), CONFIG_ROOT, CONFIG_FILES);
  }
  return { target: name, dir: src, profiles: ids.length - skipped.length, skipped, note: "restart the launcher if new proxies do not show up" };
}

export function status() {
  const t = targets();
  const remote = Object.fromEntries(
    Object.entries(t).map(([n, d]) => {
      const profiles = d ? idsIn(d).map((id) => ({ id, name: readJson(path.join(d, "profiles", `${id}.json`), {}).name || "" })) : [];
      const parent = d && path.dirname(d);
      const reachable = !!d && (fs.existsSync(d) || (fs.existsSync(parent) && !MOUNT_ROOTS.includes(parent)));
      const locks = d ? profiles.map((p) => ({ id: p.id, lock: remoteLock(d, p.id) })).filter((x) => x.lock)
        .map(({ id, lock }) => ({ id, host: lock.host, mine: lock.machine === machineId(), minutes_ago: Math.floor((now() - lock.at) / 60), stale: now() - lock.at >= LOCK_STALE_SECS })) : [];
      return [n, { dir: d, reachable, profiles, locks, last_push: d ? readJson(path.join(d, "LAST_PUSH.json"), null) : null }];
    }),
  );
  return { data_root: dataRoot(), auto: readJson(SYNC_CONF, {}).auto || null, running: running(path.join(dataRoot(), "user-data")), targets: remote };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    const out = cmd === "push" ? push(a, b) : cmd === "pull" ? pull(a, b) : cmd === "set" ? setTarget(a, b)
      : cmd === "auto" ? setAuto(a) : cmd === "takeover" ? takeOver(a) : status();
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

// Tracker for launched ShardX child processes; keyed by profile_id.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tokio::process::Child;

pub struct Tracker {
    inner: Mutex<HashMap<String, ChildEntry>>,
}

struct ChildEntry {
    pid: u32,
    killer: tokio::sync::mpsc::Sender<()>,
    /// Set once DevToolsActivePort is read; None for UI launches.
    cdp: Option<CdpInfo>,
    /// Process start; serialised as elapsed ms in RunningProfile.
    started_at: Instant,
}

/// CDP endpoint for an API-launched profile.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CdpInfo {
    pub port: u16,
    pub http_url: String,
    /// ws://127.0.0.1:<port>/devtools/browser/<id> for Puppeteer/Playwright.
    pub web_socket_debugger_url: String,
}

impl Tracker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Take a spawned child + monitor it; entry removed on exit/kill.
    pub fn track(self: &'static Self, profile_id: String, mut child: Child, temporary: bool) -> u32 {
        let pid = child.id().unwrap_or(0);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);

        {
            let mut g = self.inner.lock().unwrap();
            let previous = g.insert(
                profile_id.clone(),
                ChildEntry { pid, killer: tx, cdp: None, started_at: Instant::now() },
            );
            // Replacing the entry drops the old killer and orphans that browser.
            // `launch` refuses a second launch up front; this is the backstop.
            if let Some(prev) = previous {
                // The same pid means the status poll adopted this very browser in
                // the moment between spawn and here: hand over, never kill it.
                if prev.pid != pid {
                    eprintln!(
                        "[tracker] {profile_id} was already tracked as pid {}; stopping it",
                        prev.pid
                    );
                    let _ = prev.killer.try_send(());
                }
            }
        }

        // Graceful shutdown (SIGTERM / taskkill WM_CLOSE) → 5s → hard kill.
        // Graceful path flushes session state so next launch skips the restore prompt.
        let started_at = Instant::now();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = rx.recv() => {
                    #[cfg(unix)]
                    {
                        if let Some(p) = child.id() {
                            // SAFETY: libc::kill on a child pid we own.
                            unsafe { libc::kill(p as libc::pid_t, libc::SIGTERM); }
                        }
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        if let Some(p) = child.id() {
                            // taskkill /PID without /F posts WM_CLOSE for clean shutdown.
                            // 0x08000000 = CREATE_NO_WINDOW — suppress the console flash.
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &p.to_string()])
                                .creation_flags(0x08000000)
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null())
                                .status();
                        }
                    }
                    let graceful = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        child.wait(),
                    ).await;
                    if graceful.is_err() {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                    }
                }
            }
            if let Ok(mut g) = Self::shared().inner.lock() {
                g.remove(&profile_id);
            }
            // Bump the persisted total runtime; non-temporary only (temp
            // profiles get deleted next line so their counter is moot).
            if !temporary {
                let elapsed_ms = started_at.elapsed().as_millis() as u64;
                if let Err(e) = crate::profile::add_runtime(&profile_id, elapsed_ms) {
                    eprintln!("[launcher] add_runtime({profile_id}) failed: {e}");
                }
                // Auto sync: upload what this session changed, release the lock.
                let id = profile_id.clone();
                let _ = tokio::task::spawn_blocking(move || crate::cloud_sync::after_exit(&id)).await;
            }
            // Tear down temporary profile (config + udd) on close.
            if temporary {
                match crate::profile::delete(&profile_id) {
                    Ok(()) => eprintln!("[launcher] temporary profile {profile_id} deleted on close"),
                    Err(e) => eprintln!("[launcher] temporary profile {profile_id} cleanup failed: {e}"),
                }
            }
        });

        pid
    }

    /// Attach CDP to a tracked profile; no-op if the profile already exited.
    pub fn set_cdp(&self, profile_id: &str, cdp: CdpInfo) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(e) = g.get_mut(profile_id) {
                e.cdp = Some(cdp);
            }
        }
    }

    /// CDP endpoint when the profile was launched with remote debugging.
    /// Whether a child is live for this profile.
    pub fn is_running(&self, profile_id: &str) -> bool {
        self.inner
            .lock()
            .map(|g| g.contains_key(profile_id))
            .unwrap_or(false)
    }

    pub fn cdp(&self, profile_id: &str) -> Option<CdpInfo> {
        self.inner.lock().ok()?.get(profile_id)?.cdp.clone()
    }

    pub fn running(&self) -> Vec<RunningProfile> {
        let g = self.inner.lock().unwrap();
        g.iter()
            .map(|(id, e)| RunningProfile {
                profile_id: id.clone(),
                pid: e.pid,
                cdp: e.cdp.clone(),
                uptime_ms: e.started_at.elapsed().as_millis() as u64,
            })
            .collect()
    }

    pub async fn kill(&self, profile_id: &str) -> Result<bool> {
        let killer = {
            let g = self.inner.lock().unwrap();
            g.get(profile_id).map(|e| e.killer.clone())
        };
        if let Some(k) = killer {
            let _ = k.send(()).await;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Takes over browsers this launcher did not start: it was quit or crashed
    /// while they ran, so its successor would show them idle and a Start would
    /// only hand off to the running instance and exit. Found through Chromium's
    /// SingletonLock; called at startup and on every status poll.
    #[cfg(unix)]
    pub fn adopt_orphans(&'static self) {
        let Ok(root) = crate::store::user_data_root() else { return };
        let Ok(rd) = std::fs::read_dir(&root) else { return };
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            if !self.is_running(&id) {
                if let Some(pid) = orphan_pid(&e.path()) {
                    self.adopt(id, pid, &e.path());
                }
            }
        }
    }

    #[cfg(not(unix))]
    pub fn adopt_orphans(&'static self) {}

    /// Adopts the browser already running this profile, if any.
    #[cfg(unix)]
    pub fn adopt_if_orphan(&'static self, profile_id: &str) -> Option<u32> {
        if profile_id.is_empty() || profile_id.contains(['/', '\\', '.']) {
            return None;
        }
        let udd = crate::store::user_data_root().ok()?.join(profile_id);
        let pid = orphan_pid(&udd)?;
        self.adopt(profile_id.to_string(), pid, &udd);
        Some(pid)
    }

    #[cfg(not(unix))]
    pub fn adopt_if_orphan(&'static self, _profile_id: &str) -> Option<u32> {
        None
    }

    #[cfg(unix)]
    fn adopt(&'static self, profile_id: String, pid: u32, udd: &std::path::Path) {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
        let cdp = adopted_cdp(udd, pid); // runs ps: outside the lock
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if g.contains_key(&profile_id) {
                return;
            }
            g.insert(profile_id.clone(), ChildEntry { pid, killer: tx, cdp, started_at: Instant::now() });
        }
        eprintln!("[tracker] adopted running browser pid {pid} for {profile_id}");
        // The old launcher's auto-sync heartbeat died with it; pick it up again.
        {
            let id = profile_id.clone();
            std::thread::spawn(move || crate::cloud_sync::resume_heartbeat(&id));
        }
        let udd = udd.to_path_buf();
        let adopted_at = Instant::now();
        tauri::async_runtime::spawn(async move {
            let alive = |p: u32| unsafe { libc::kill(p as libc::pid_t, 0) == 0 };
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                        if !alive(pid) { break; }
                    }
                    msg = rx.recv() => {
                        // Sender dropped: track() took this pid over. Not ours any more.
                        if msg.is_none() { return; }
                        // Same as a launched child: graceful first, hard after 5s.
                        // Each signal goes only to a pid confirmed, right then, to
                        // be this profile's browser: a recycled pid is never hit.
                        // SAFETY: plain signals to a verified pid.
                        if still_ours(pid, &udd) {
                            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM); }
                        }
                        for _ in 0..25 {
                            if !alive(pid) { break; }
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                        if still_ours(pid, &udd) {
                            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL); }
                        }
                        break;
                    }
                }
            }
            if let Ok(mut g) = Self::shared().inner.lock() {
                g.remove(&profile_id);
            }
            let temporary = crate::profile::load_raw(&profile_id).map(|s| s.meta.temporary).unwrap_or(false);
            if temporary {
                let _ = crate::profile::delete(&profile_id);
            } else {
                // Counts from adoption: the part before belonged to the old launcher.
                let _ = crate::profile::add_runtime(&profile_id, adopted_at.elapsed().as_millis() as u64);
                let id = profile_id.clone();
                let _ = tokio::task::spawn_blocking(move || crate::cloud_sync::after_exit(&id)).await;
            }
        });
    }

    pub fn shared() -> &'static Tracker {
        static INSTANCE: std::sync::OnceLock<Tracker> = std::sync::OnceLock::new();
        INSTANCE.get_or_init(Tracker::new)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunningProfile {
    pub profile_id: String,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp: Option<CdpInfo>,
    /// Milliseconds since the engine was spawned; frontend formats as
    /// "1h 23m" / "12m 30s" / "45s".
    pub uptime_ms: u64,
}

/// The live ShardX browser holding `udd`, from Chromium's SingletonLock
/// ("<host>-<pid>"): same host, pid alive, and its command line names this
/// user-data dir, so a recycled pid is never mistaken for ours.
#[cfg(unix)]
fn orphan_pid(udd: &std::path::Path) -> Option<u32> {
    // Locks already found not to be ours (a crash leftover whose pid now runs
    // something else): skip the ps call on every 2s poll.
    static NOT_OURS: std::sync::Mutex<Option<HashMap<std::path::PathBuf, String>>> = std::sync::Mutex::new(None);
    let target = std::fs::read_link(udd.join("SingletonLock")).ok()?.to_string_lossy().into_owned();
    let (host, pid) = target.rsplit_once('-')?;
    let pid: u32 = pid.parse().ok()?;
    if host != this_host() || unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
        return None;
    }
    let mut cache = NOT_OURS.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    if cache.get(udd) == Some(&target) {
        return None;
    }
    if still_ours(pid, udd) {
        Some(pid)
    } else {
        cache.insert(udd.to_path_buf(), target);
        None
    }
}

/// `pid` is alive and its command line passes exactly this user-data dir.
#[cfg(unix)]
fn still_ours(pid: u32, udd: &std::path::Path) -> bool {
    if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
        return false;
    }
    let Ok(out) = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output() else {
        return false;
    };
    let cmd = String::from_utf8_lossy(&out.stdout);
    let arg = format!("--user-data-dir={}", udd.display());
    cmd.match_indices(&arg).any(|(i, _)| matches!(cmd[i + arg.len()..].chars().next(), None | Some(' ' | '\n')))
}

#[cfg(unix)]
fn this_host() -> String {
    static H: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    H.get_or_init(|| {
        let mut buf = [0u8; 256];
        // SAFETY: gethostname writes at most buf.len() bytes, NUL-terminated.
        unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    })
    .clone()
}

/// The debugging endpoint of an adopted browser, when it was launched with one.
#[cfg(unix)]
fn adopted_cdp(udd: &std::path::Path, pid: u32) -> Option<CdpInfo> {
    let out = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    if !String::from_utf8_lossy(&out.stdout).contains("--remote-debugging-port") {
        return None;
    }
    let txt = std::fs::read_to_string(udd.join("DevToolsActivePort")).ok()?;
    let mut lines = txt.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim().to_string();
    Some(CdpInfo {
        port,
        http_url: format!("http://127.0.0.1:{port}"),
        web_socket_debugger_url: format!("ws://127.0.0.1:{port}{path}"),
    })
}

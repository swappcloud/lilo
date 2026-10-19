//! Memory, CPU and threads of **the whole LILO**: the host process and
//! everything hanging off it — plugins in their own process, webviews, the
//! media player.
//!
//! The Storage panel answers "is this worth it?", so the number that matters is
//! the app's cost, not the system's. Each OS walks the process tree with what
//! the box already has: `windows` on Windows, `/proc` on Linux, `ps` on macOS.

use serde::Serialize;

/// What a process in LILO's tree is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessKind {
    /// O host: o app em si e os plugins embarcados (quickjs).
    Host,
    /// Plugins that run as their own process (JSON over stdio).
    Plugins,
    /// As janelas web por backend (WebView2 / WebKitGTK / WKWebView).
    Webviews,
    /// mpv e yt-dlp.
    Media,
    /// What is left in the tree (crashpad, helpers).
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroup {
    pub kind: ProcessKind,
    pub rss_bytes: u64,
    pub cpu_seconds: f64,
    pub threads: u32,
    pub processes: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    /// Sum over the whole tree.
    pub rss_bytes: u64,
    pub cpu_seconds: f64,
    pub threads: u32,
    /// How many processes LILO keeps alive (the host included).
    pub processes: u32,
    /// Since when the host has been up.
    pub uptime_seconds: u64,
    /// Breakdown by group, in the order the panel shows.
    pub groups: Vec<ProcessGroup>,
}

/// One row of the OS's process enumeration.
#[derive(Debug, Clone)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub rss_bytes: u64,
    pub cpu_seconds: f64,
    pub threads: u32,
}

/// A browser engine's web process: WebView2 and WebKitGTK spawn theirs as
/// direct children, WKWebView's are launchd children adopted by responsible pid.
fn is_webview(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("webview")
        || name.contains("webkit")
        || name.contains("webcontent")
        || name.contains("webprocess")
}

/// What to do with a process in the tree.
fn classify(name: &str, pid: u32, host: u32, plugin_pids: &[u32]) -> ProcessKind {
    if pid == host {
        return ProcessKind::Host;
    }
    if is_webview(name) {
        return ProcessKind::Webviews;
    }
    let name = name.to_ascii_lowercase();
    if name.starts_with("mpv") || name.starts_with("yt-dlp") {
        return ProcessKind::Media;
    }
    // A process the plugin registry recognizes is its own; any other direct
    // child that lands here can only have been opened by a plugin.
    if plugin_pids.contains(&pid) {
        return ProcessKind::Plugins;
    }
    ProcessKind::Other
}

/// Who is in the tree rooted at `root`. Pure: each OS enumerates the
/// (pid, ppid) pairs at once and only opens the processes that matter — opening
/// everything and discarding most of it is what makes the read expensive.
pub fn tree_members(root: u32, rows: &[ProcRow]) -> std::collections::HashSet<u32> {
    let mut included = std::collections::HashSet::new();
    included.insert(root);
    // The enumeration may come in any order; the tree closes by repetition.
    loop {
        let mut grew = false;
        for row in rows {
            if included.contains(&row.pid) {
                continue;
            }
            if included.contains(&row.ppid) {
                included.insert(row.pid);
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    included
}

/// Sums the tree rooted at `root`, grouping by kind.
///
/// Pure and testable: each OS only produces the rows, the arithmetic is the same.
pub fn summarize(root: u32, plugin_pids: &[u32], rows: &[ProcRow]) -> ProcessUsage {
    let included = tree_members(root, rows);

    let mut groups: Vec<ProcessGroup> = Vec::new();
    let mut usage = ProcessUsage::default();
    for row in rows {
        if !included.contains(&row.pid) {
            continue;
        }
        let kind = classify(&row.name, row.pid, root, plugin_pids);
        usage.rss_bytes += row.rss_bytes;
        usage.cpu_seconds += row.cpu_seconds;
        usage.threads += row.threads;
        usage.processes += 1;
        match groups.iter_mut().find(|group| group.kind == kind) {
            Some(group) => {
                group.rss_bytes += row.rss_bytes;
                group.cpu_seconds += row.cpu_seconds;
                group.threads += row.threads;
                group.processes += 1;
            }
            None => groups.push(ProcessGroup {
                kind,
                rss_bytes: row.rss_bytes,
                cpu_seconds: row.cpu_seconds,
                threads: row.threads,
                processes: 1,
            }),
        }
    }
    // Ordem fixa: host, plugins, webviews, media, other.
    groups.sort_by_key(|group| match group.kind {
        ProcessKind::Host => 0,
        ProcessKind::Plugins => 1,
        ProcessKind::Webviews => 2,
        ProcessKind::Media => 3,
        ProcessKind::Other => 4,
    });
    usage.groups = groups;
    usage
}

/// One sample of LILO's tree, with the pids of process plugins.
pub fn sample(plugin_pids: &[u32]) -> ProcessUsage {
    let mut usage = imp::tree(plugin_pids);
    usage.uptime_seconds = imp::host_uptime();
    usage
}

/// The next whitespace-delimited field, advancing `rest` past it.
///
/// `ps` pads columns with *runs* of spaces, so `splitn` by a whitespace
/// character yields empty fields; the run is skipped before the field is taken.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn take_field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let current: &'a str = rest;
    let trimmed = current.trim_start();
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let (field, tail) = trimmed.split_at(end);
    *rest = tail;
    (!field.is_empty()).then_some(field)
}

/// Reparent web processes the ppid walk cannot reach onto `root`.
///
/// macOS runs WebKit's helpers (`WebContent`, `GPU`, `Networking`) as launchd
/// children, so their ppid is 1 and the tree rooted at the host never sees them
/// — most of what the app costs. macOS tracks the link separately, as the
/// *responsible* process: a web process is adopted only when its responsible
/// pid is the host's own — exact for the packaged app, and for a dev run the
/// editor that launched it. `responsible_of` is the platform lookup, so the
/// rule itself stays testable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn adopt_responsible<F: Fn(u32) -> Option<i32>>(
    rows: &mut [ProcRow],
    root: u32,
    host_responsible: i32,
    responsible_of: F,
) {
    for row in rows.iter_mut() {
        if row.pid != root
            && is_webview(&row.name)
            && responsible_of(row.pid) == Some(host_responsible)
        {
            row.ppid = root;
        }
    }
}

/// Count threads from `ps -M` output: one line per thread, each naming its pid.
///
/// `ps -axo` has no thread column on macOS, so this is the box's own answer.
/// The pid is the only integer on a thread line, and a stray one is ignored by
/// keeping only the pids asked for.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn count_thread_lines<'a, I: Iterator<Item = &'a str>>(
    lines: I,
    wanted: &std::collections::HashSet<u32>,
) -> std::collections::HashMap<u32, u32> {
    let mut counts = std::collections::HashMap::new();
    for line in lines {
        if let Some(pid) = line
            .split_whitespace()
            .find_map(|token| token.parse::<u32>().ok())
            .filter(|pid| wanted.contains(pid))
        {
            *counts.entry(pid).or_insert(0) += 1;
        }
    }
    counts
}

/// One line of `ps -axo pid=,ppid=,rss=,time=,comm=` (macOS).
///
/// `comm` is the executable's full path and may contain spaces
/// (`/Applications/Google Chrome.app/…`), so the name is everything left after
/// the four leading columns; only its last path component is kept, which is the
/// name the panel classifies against.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_ps_line(line: &str) -> Option<ProcRow> {
    let mut rest = line;
    let pid = take_field(&mut rest)?.parse::<u32>().ok()?;
    let ppid = take_field(&mut rest)?.parse::<u32>().ok()?;
    let rss = take_field(&mut rest)?.parse::<u64>().ok()?;
    let cpu_seconds = parse_clock(take_field(&mut rest)?)?;
    let name = rest.trim();
    let name = name.rsplit('/').next().unwrap_or(name);
    if name.is_empty() {
        return None;
    }
    Some(ProcRow {
        pid,
        ppid,
        name: name.to_string(),
        rss_bytes: rss.saturating_mul(1024),
        cpu_seconds,
        // `ps -axo` has no thread column; the macOS tree() adds it from `ps -M`,
        // and a row the count misses keeps zero.
        threads: 0,
    })
}

/// "[[dd-]hh:]mm:ss[.ff]" — o formato de `ps -o time=` e `ps -o etime=` no
/// macOS. Seconds, with the fraction when there is one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_clock(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (days, rest) = match text.split_once('-') {
        Some((days, rest)) => (days.parse::<f64>().ok()?, rest),
        None => (0.0, text),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [seconds] => (0.0, 0.0, seconds.parse::<f64>().ok()?),
        [minutes, seconds] => (
            0.0,
            minutes.parse::<f64>().ok()?,
            seconds.parse::<f64>().ok()?,
        ),
        [hours, minutes, seconds] => (
            hours.parse::<f64>().ok()?,
            minutes.parse::<f64>().ok()?,
            seconds.parse::<f64>().ok()?,
        ),
        _ => return None,
    };
    Some(days * 86_400.0 + hours * 3_600.0 + minutes * 60.0 + seconds)
}

#[cfg(windows)]
mod imp {
    use super::{summarize, ProcRow, ProcessUsage};
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    /// Windows conta em ticks de 100 ns desde 1601.
    const EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;

    fn ticks(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    /// Name, parent and threads of every process in one Toolhelp pass.
    /// Opens nothing: the tree is closed first, then only its members are opened.
    fn enumerate() -> Vec<ProcRow> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let pid = entry.th32ProcessID;
                    let name = String::from_utf16_lossy(
                        &entry.szExeFile[..entry
                            .szExeFile
                            .iter()
                            .position(|c| *c == 0)
                            .unwrap_or(entry.szExeFile.len())],
                    );
                    if pid != 0 {
                        out.push(ProcRow {
                            pid,
                            ppid: entry.th32ParentProcessID,
                            name,
                            rss_bytes: 0,
                            cpu_seconds: 0.0,
                            threads: entry.cntThreads,
                        });
                    }
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        out
    }

    /// Memory and CPU of one process — two opens, and only for what matters.
    /// Not every process allows reading (protected system ones); without
    /// permission the row keeps only its name.
    fn metrics(row: &mut ProcRow) {
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, row.pid) {
                let (mut creation, mut exit, mut kernel, mut user) = (
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                );
                if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).is_ok()
                {
                    row.cpu_seconds = (ticks(kernel) + ticks(user)) as f64 / 10_000_000.0;
                }
                let _ = CloseHandle(handle);
            }
            // A second handle: reading memory needs PROCESS_VM_READ, which the
            // times handle does not ask for. Without it the row keeps rss = 0.
            if let Ok(memory_handle) = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                false,
                row.pid,
            ) {
                let mut counters = PROCESS_MEMORY_COUNTERS {
                    cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                    ..Default::default()
                };
                if GetProcessMemoryInfo(memory_handle, &mut counters, counters.cb).is_ok() {
                    row.rss_bytes = counters.WorkingSetSize as u64;
                }
                let _ = CloseHandle(memory_handle);
            }
        }
    }

    pub fn host_uptime() -> u64 {
        // The host's age is the current process's: GetProcessTimes at creation.
        unsafe {
            use windows::Win32::System::Threading::GetCurrentProcess;
            let mut creation = FILETIME::default();
            let (mut exit, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            if GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
            .is_err()
            {
                return 0;
            }
            let started = ticks(creation).saturating_sub(EPOCH_OFFSET_100NS) / 10_000_000;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or(started);
            now.saturating_sub(started)
        }
    }

    pub fn tree(plugin_pids: &[u32]) -> ProcessUsage {
        let mut rows = enumerate();
        let root = std::process::id();
        let members = super::tree_members(root, &rows);
        for row in rows.iter_mut().filter(|row| members.contains(&row.pid)) {
            metrics(row);
        }
        summarize(root, plugin_pids, &rows)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{summarize, ProcRow, ProcessUsage};

    /// `getconf CLK_TCK` is 100 on any Linux that matters, the Pi included.
    const USER_HZ: f64 = 100.0;
    /// `/proc/<pid>/statm` counts pages.
    const PAGE_SIZE: u64 = 4096;

    pub fn host_uptime() -> u64 {
        let mut seconds = 0.0;
        if let Ok(stat) = std::fs::read_to_string("/proc/self/stat") {
            if let Some((_, rest)) = stat.rsplit_once(')') {
                if let Some(field) = rest.split_whitespace().nth(19) {
                    seconds = field.parse::<f64>().unwrap_or(0.0) / USER_HZ;
                }
            }
        }
        if let Ok(uptime) = std::fs::read_to_string("/proc/uptime") {
            if let Some(boot) = uptime
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<f64>().ok())
            {
                return (boot - seconds).max(0.0) as u64;
            }
        }
        0
    }

    /// Only `/proc/<pid>/stat`: name, parent, CPU and threads, without touching
    /// memory. The tree closes from that, and only its members get `statm`.
    fn enumerate() -> Vec<ProcRow> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return out;
        };
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_string_lossy().parse::<u32>().ok() else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            // After the ")" (the name may contain spaces) comes field 3:
            // state=0 … ppid=1, utime=11, stime=12, num_threads=17.
            let Some((name, rest)) = stat.rsplit_once(')') else {
                continue;
            };
            let name = name
                .rsplit_once('(')
                .map(|(_, n)| n)
                .unwrap_or(name)
                .to_string();
            let fields: Vec<&str> = rest.split_whitespace().collect();
            let field = |index: usize| {
                fields
                    .get(index)
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0)
            };
            out.push(ProcRow {
                pid,
                ppid: field(1) as u32,
                name,
                rss_bytes: 0,
                cpu_seconds: (field(11) + field(12)) as f64 / USER_HZ,
                threads: field(17) as u32,
            });
        }
        out
    }

    fn metrics(row: &mut ProcRow) {
        let path = format!("/proc/{}/statm", row.pid);
        row.rss_bytes = std::fs::read_to_string(path)
            .ok()
            .and_then(|statm| {
                statm
                    .split_whitespace()
                    .nth(1)
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .map(|pages| pages * PAGE_SIZE)
            .unwrap_or(0);
    }

    pub fn tree(plugin_pids: &[u32]) -> ProcessUsage {
        let mut rows = enumerate();
        let root = std::process::id();
        let members = super::tree_members(root, &rows);
        for row in rows.iter_mut().filter(|row| members.contains(&row.pid)) {
            metrics(row);
        }
        summarize(root, plugin_pids, &rows)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{parse_clock, summarize, ProcRow, ProcessUsage};

    /// `ps -axo` gives the whole tree in one call — cheaper than `proc_pidinfo`
    /// per process, and without dragging in libc.
    fn rows() -> Vec<ProcRow> {
        let Ok(output) = std::process::Command::new("ps")
            .args(["-axo", "pid=,ppid=,rss=,time=,comm="])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(super::parse_ps_line)
            .collect()
    }

    pub fn host_uptime() -> u64 {
        let pid = std::process::id().to_string();
        std::process::Command::new("ps")
            .args(["-o", "etime=", "-p", &pid])
            .output()
            .ok()
            .and_then(|output| parse_clock(&String::from_utf8_lossy(&output.stdout)))
            .map(|seconds| seconds as u64)
            .unwrap_or(0)
    }

    pub fn tree(plugin_pids: &[u32]) -> ProcessUsage {
        let mut rows = rows();
        let root = std::process::id();
        if let Some(host_responsible) = responsible(root) {
            super::adopt_responsible(&mut rows, root, host_responsible, responsible);
        }
        // One more call, for the members only: thread counts are not in the
        // tree sample, and a row without one reads as zero.
        let members: Vec<u32> = super::tree_members(root, &rows).into_iter().collect();
        let counts = thread_counts(&members);
        for row in rows.iter_mut() {
            if let Some(count) = counts.get(&row.pid) {
                row.threads = *count;
            }
        }
        summarize(root, plugin_pids, &rows)
    }

    /// Threads per process, from `ps -M`: one line per thread.
    fn thread_counts(members: &[u32]) -> std::collections::HashMap<u32, u32> {
        if members.is_empty() {
            return std::collections::HashMap::new();
        }
        let wanted: std::collections::HashSet<u32> = members.iter().copied().collect();
        let list = members
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let Ok(output) = std::process::Command::new("ps")
            .args(["-M", "-p", &list])
            .output()
        else {
            return std::collections::HashMap::new();
        };
        super::count_thread_lines(String::from_utf8_lossy(&output.stdout).lines(), &wanted)
    }

    /// The process macOS attributes `pid` to. Exported by libSystem but not
    /// declared in the public SDK headers; `-1` when it has no answer.
    fn responsible(pid: u32) -> Option<i32> {
        extern "C" {
            fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
        }
        let value = unsafe { responsibility_get_pid_responsible_for_pid(pid as i32) };
        (value > 0).then_some(value)
    }
}

/// Platforms without measurement (or future ones): only the process itself.
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod imp {
    use super::ProcessUsage;

    pub fn tree(_plugin_pids: &[u32]) -> ProcessUsage {
        ProcessUsage::default()
    }

    pub fn host_uptime() -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clock_parses_every_shape_ps_prints() {
        assert_eq!(parse_clock("0:01.23"), Some(1.23));
        assert_eq!(parse_clock("12:34"), Some(754.0));
        assert_eq!(parse_clock("1:02:03"), Some(3_723.0));
        assert_eq!(parse_clock("2-01:00:00"), Some(176_400.0));
        assert_eq!(parse_clock(""), None);
        assert_eq!(parse_clock("nonsense"), None);
    }

    /// `ps` separates its columns with runs of spaces; a parser that treats
    /// each space as a separator drops every row and the panel reads zero.
    #[test]
    fn a_macos_ps_line_parses_despite_the_whitespace_runs() {
        let row = parse_ps_line("    1     0  37216   3:29.25 /sbin/launchd").expect("a row");
        assert_eq!(row.pid, 1);
        assert_eq!(row.ppid, 0);
        assert_eq!(row.rss_bytes, 37_216 * 1024);
        assert_eq!(row.cpu_seconds, 209.25);
        assert_eq!(row.name, "launchd");
    }

    /// `comm` is a path, and the path can contain spaces: the name keeps its
    /// spaces and drops the directories.
    #[test]
    fn a_macos_process_name_is_the_last_path_component() {
        let row = parse_ps_line(
            "20372     1 419840   0:07.15 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )
        .expect("a row");
        assert_eq!(row.name, "Google Chrome");
        assert_eq!(row.pid, 20_372);
        assert_eq!(row.cpu_seconds, 7.15);
    }

    #[test]
    fn a_macos_line_that_is_not_a_row_is_skipped() {
        assert!(parse_ps_line("").is_none());
        assert!(parse_ps_line("  PID  PPID    RSS     TIME COMM").is_none());
        assert!(parse_ps_line("1 2 3 not-a-clock /bin/sh").is_none());
        assert!(parse_ps_line("1 2 3 0:01").is_none());
    }

    /// WebKit helpers are launchd children, so only the responsible pid can
    /// tell LILO's apart from another app's.
    #[test]
    fn only_webviews_responsible_to_the_host_are_adopted() {
        let mut rows = vec![
            row(20, 1, "com.apple.WebKit.WebContent", 100),
            row(21, 1, "com.apple.WebKit.WebContent", 200),
            row(22, 1, "com.apple.WebKit.GPU", 50),
            row(23, 1, "com.apple.WebKit.Networking", 25),
            row(24, 1, "some.helper", 10),
        ];
        let host_responsible = 42;
        adopt_responsible(&mut rows, 10, host_responsible, |pid| match pid {
            20 | 22 | 24 => Some(host_responsible),
            21 | 23 => Some(7),
            _ => None,
        });

        assert_eq!(rows[0].ppid, 10, "LILO's WebContent joins the tree");
        assert_eq!(rows[1].ppid, 1, "another app's WebContent stays out");
        assert_eq!(rows[2].ppid, 10, "LILO's GPU process joins too");
        assert_eq!(rows[3].ppid, 1, "another app's Networking stays out");
        assert_eq!(rows[4].ppid, 1, "a non-web helper is not adopted");

        // And the adopted rows land in the webviews group.
        let usage = summarize(10, &[], &rows);
        let webviews = usage
            .groups
            .iter()
            .find(|group| group.kind == ProcessKind::Webviews)
            .expect("webviews");
        assert_eq!(webviews.processes, 2);
        assert_eq!(webviews.rss_bytes, 150);
    }

    #[test]
    fn adoption_without_a_responsible_answer_changes_nothing() {
        let mut rows = vec![row(20, 1, "com.apple.WebKit.WebContent", 100)];
        adopt_responsible(&mut rows, 10, 42, |_| None);
        assert_eq!(rows[0].ppid, 1);
    }

    /// `ps -M` prints a header and one line per thread; the pid repeats on each
    /// line, and pids outside the sample are not counted.
    #[test]
    fn ps_m_lines_count_one_thread_each() {
        let output = "\
USER              PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND
jane.doe        35994 s003    0.0 S    46T   0:00.44   0:01.09 /Users/foo
                35994         0.1 S    46T   0:00.06   0:00.06
                35994         0.0 S    37T   0:00.00   0:00.00
                36112         0.0 S    37T   0:00.00   0:00.00
            99999999         0.0 S    37T   0:00.00   0:00.00";
        let wanted: std::collections::HashSet<u32> = [35_994, 36_112].into_iter().collect();
        let counts = count_thread_lines(output.lines(), &wanted);
        assert_eq!(counts.get(&35_994), Some(&3));
        assert_eq!(counts.get(&36_112), Some(&1));
        assert_eq!(counts.len(), 2, "a pid that was not asked for is ignored");
    }

    fn row(pid: u32, ppid: u32, name: &str, rss: u64) -> ProcRow {
        ProcRow {
            pid,
            ppid,
            name: name.to_string(),
            rss_bytes: rss,
            cpu_seconds: 1.0,
            threads: 2,
        }
    }

    #[test]
    fn only_the_host_tree_counts_and_groups_add_up() {
        let rows = vec![
            row(10, 0, "lilo.exe", 100),
            row(11, 10, "msedgewebview2.exe", 400),
            row(12, 10, "powershell.exe", 50),
            row(13, 11, "msedgewebview2.exe", 200),
            row(14, 10, "mpv.exe", 30),
            row(15, 10, "crashpad_handler.exe", 5),
            // Another app, outside the tree: it must not enter anything.
            row(99, 1, "chrome.exe", 9_999),
        ];
        let usage = summarize(10, &[12], &rows);
        // Host, webview, plugin, webview child, mpv, crashpad.
        assert_eq!(usage.processes, 6);
        assert_eq!(usage.rss_bytes, 785);
        let group = |kind: ProcessKind| usage.groups.iter().find(|g| g.kind == kind).unwrap();
        assert_eq!(group(ProcessKind::Host).rss_bytes, 100);
        assert_eq!(group(ProcessKind::Webviews).rss_bytes, 600);
        assert_eq!(group(ProcessKind::Webviews).processes, 2);
        assert_eq!(group(ProcessKind::Plugins).rss_bytes, 50);
        assert_eq!(group(ProcessKind::Media).rss_bytes, 30);
        assert_eq!(group(ProcessKind::Other).rss_bytes, 5);
        assert!(usage.groups.len() <= rows.len());
    }

    #[test]
    fn the_tree_closure_ignores_unrelated_processes() {
        let rows = vec![
            row(10, 0, "lilo.exe", 100),
            row(11, 10, "msedgewebview2.exe", 400),
            row(12, 11, "msedgewebview2.exe", 200),
            row(99, 1, "chrome.exe", 9_999),
        ];
        let members = tree_members(10, &rows);
        assert!(members.contains(&10) && members.contains(&11) && members.contains(&12));
        assert!(!members.contains(&99));
    }

    #[test]
    fn a_sample_of_the_real_tree_is_taken_without_panicking() {
        let usage = sample(&[]);
        assert!(usage.processes >= 1, "the host is always in the tree");
        assert!(usage.cpu_seconds >= 0.0);
    }
}

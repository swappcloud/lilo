//! Running a command on a quickjs plugin's declared terms.
//!
//! The embedded engine cannot reach the machine on its own. `lilo.exec` is the
//! one door, and the manifest is the key: a plugin may run exactly the binaries
//! it declared as `exec:<name>`, by bare name, as an argv array — never through
//! a shell, so nothing it builds is ever interpreted. The child gets the
//! host's minimal environment (never the user's), starts in the plugin's own
//! folder, and is bounded by a wall-clock budget and an output cap: a script
//! that hangs or floods its pipe fails its own call, not the host.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{AppError, Result};

/// How long a declared command may run. `open`, `ls` and friends answer in
/// milliseconds; anything slower is broken, not busy.
pub(crate) const EXEC_TIMEOUT: Duration = Duration::from_secs(15);

/// Bytes kept per stream. Enough for a listing or a short error message; the
/// pipe keeps being drained past it, so a chatty program cannot block itself.
pub(crate) const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// What a declared command produced.
#[derive(Debug)]
pub(crate) struct Output {
    /// Exit status, or -1 when the process was killed by a signal.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Whether the plugin declared exactly this binary, as a bare name.
///
/// A path is not a name: `/bin/sh`, `../x` and `cmd:foo` cannot match, so a
/// declared capability cannot be widened at call time.
pub(crate) fn declared(capabilities: &[String], program: &str) -> bool {
    if program.is_empty()
        || program.contains('/')
        || program.contains('\\')
        || program.contains(':')
        || program == "."
        || program == ".."
    {
        return false;
    }
    capabilities.iter().any(|capability| {
        capability
            .strip_prefix("exec:")
            .is_some_and(|allowed| allowed == program)
    })
}

/// Run `program` with `args`, in `dir`, under the budget.
pub(crate) fn run(dir: &Path, program: &str, args: &[String]) -> Result<Output> {
    let mut child = Command::new(program)
        .args(args.iter().map(|argument| expand_home(argument)))
        .current_dir(dir)
        .env_clear()
        .envs(
            super::INHERITED_ENV
                .iter()
                .filter_map(|key| std::env::var_os(key).map(|value| (key.to_string(), value))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::other(format!("could not run {program}: {error}")))?;

    // Read both pipes on their own threads: a child that writes more than a
    // pipe buffer holds would otherwise block before we ever wait for it.
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);

    let deadline = Instant::now() + EXEC_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::other(format!(
                        "{program} did not finish within {}s",
                        EXEC_TIMEOUT.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                return Err(AppError::other(format!(
                    "could not wait for {program}: {error}"
                )));
            }
        }
    };

    Ok(Output {
        code: status.code().unwrap_or(-1),
        stdout: stdout
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default(),
        stderr: stderr
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default(),
    })
}

/// A leading `~` in an argument expands to the user's home, the way a shell
/// would — the engine has no shell, so nothing else would. `~other/…` is left
/// alone: that is another account's home, not ours to guess.
fn expand_home(argument: &str) -> String {
    let Some(rest) = argument.strip_prefix('~') else {
        return argument.to_string();
    };
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
        return argument.to_string();
    }
    match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(home) => format!("{}{rest}", home.to_string_lossy()),
        None => argument.to_string(),
    }
}

/// Read one pipe to the end, keeping at most [`MAX_OUTPUT_BYTES`].
fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if kept.len() < MAX_OUTPUT_BYTES {
                        let room = MAX_OUTPUT_BYTES - kept.len();
                        kept.extend_from_slice(&buffer[..read.min(room)]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capabilities(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    #[test]
    fn only_a_declared_bare_name_is_allowed() {
        let declared_caps = capabilities(&["exec:open", "exec:ls"]);
        assert!(declared(&declared_caps, "open"));
        assert!(declared(&declared_caps, "ls"));

        assert!(!declared(&declared_caps, "sh"), "not declared");
        assert!(!declared(&declared_caps, "/bin/ls"), "a path is not a name");
        assert!(!declared(&declared_caps, "../ls"), "a path is not a name");
        assert!(
            !declared(&declared_caps, "exec:ls"),
            "the prefix is not the name"
        );
        assert!(
            !declared(&declared_caps, ""),
            "an empty program is not a name"
        );
        assert!(
            !declared(&capabilities(&["exec:ls -la"]), "ls"),
            "a capability is one binary, not a command line"
        );
    }

    #[test]
    fn a_leading_tilde_expands_to_the_home_folder() {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            let home = home.to_string_lossy().to_string();
            assert_eq!(expand_home("~/Code"), format!("{home}/Code"));
            assert_eq!(expand_home("~"), home);
        }
        assert_eq!(expand_home("~other/code"), "~other/code");
        assert_eq!(expand_home("/abs/path"), "/abs/path");
        assert_eq!(expand_home("plain"), "plain");
    }

    #[test]
    #[cfg(unix)]
    fn a_declared_command_runs_without_a_shell() {
        let dir = std::env::temp_dir();
        let output = run(&dir, "echo", &["hello".to_string(), ";".to_string()]).unwrap();
        assert_eq!(output.code, 0);
        // The `;` is an argument, not a separator: no shell interpreted it.
        assert_eq!(output.stdout.trim(), "hello ;");
        assert!(output.stderr.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn a_missing_program_is_an_error_not_a_panic() {
        let error = run(Path::new("/tmp"), "lilo-no-such-binary-xyz", &[]).unwrap_err();
        assert!(error.to_string().contains("could not run"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn output_past_the_cap_is_dropped() {
        let dir = std::env::temp_dir();
        let output = run(
            &dir,
            "head",
            &[
                "-c".to_string(),
                "200000".to_string(),
                "/dev/zero".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(output.code, 0);
        assert_eq!(output.stdout.len(), MAX_OUTPUT_BYTES);
    }
}

//! Quiet, bounded media subprocesses and Windows process-tree ownership.

use crate::error::{AppError, Result};
use std::ffi::OsStr;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

pub(super) fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

pub(super) fn javascript_runtime(
    command: &mut Command,
    runtime: Option<&std::path::Path>,
) -> Result<()> {
    if let Some(directory) = runtime.and_then(std::path::Path::parent) {
        let mut paths = vec![directory.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        let path = std::env::join_paths(paths)
            .map_err(|error| AppError::other(format!("Invalid media runtime path: {error}")))?;
        command.env("PATH", path);
    }
    Ok(())
}

pub(super) async fn output(command: Command, timeout: Duration) -> Result<Output> {
    let mut command = tokio::process::Command::from(command);
    command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let _job = match child.raw_handle().map(job).transpose() {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    #[cfg(not(windows))]
    let _ = &mut child;
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            AppError::other("Media request timed out. Check your connection and try again.")
        })?
        .map_err(AppError::from)
}

/// Owns the native player and, on Windows, every descendant it launches.
pub(super) struct ManagedChild {
    child: std::process::Child,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

impl std::ops::Deref for ManagedChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

pub(super) fn spawn(mut command: Command) -> Result<ManagedChild> {
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let owned_job = {
        use std::os::windows::io::AsRawHandle;
        match job(child.as_raw_handle()) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    };
    #[cfg(not(windows))]
    let _ = &mut child;
    Ok(ManagedChild {
        child,
        #[cfg(windows)]
        _job: owned_job,
    })
}

#[cfg(windows)]
fn job(process: std::os::windows::io::RawHandle) -> Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // The job handle stays in LILO and is not inherited by child processes.
    // Windows closes it even on forced app termination, killing the tree.
    unsafe {
        let handle = CreateJobObjectW(None, None)
            .map_err(|error| AppError::other(format!("Could not own media process: {error}")))?;
        let owned = OwnedHandle::from_raw_handle(handle.0);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            HANDLE(owned.as_raw_handle()),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|error| AppError::other(format!("Could not configure media cleanup: {error}")))?;
        AssignProcessToJobObject(HANDLE(owned.as_raw_handle()), HANDLE(process))
            .map_err(|error| AppError::other(format!("Could not track media process: {error}")))?;
        Ok(owned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_child_probe() {
        if let Some(mode) = std::env::var_os("LILO_MEDIA_PROCESS_TEST_CHILD") {
            #[cfg(windows)]
            assert!(
                unsafe { windows::Win32::System::Console::GetConsoleWindow() }.is_invalid(),
                "media tools must not open a console"
            );
            if mode == "report" {
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(10));
        }
    }

    #[tokio::test]
    async fn test_output_timeout_cancels_a_running_child() {
        let mut command = quiet_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", "media::process::tests::test_child_probe"])
            .env("LILO_MEDIA_PROCESS_TEST_CHILD", "1");
        let started = std::time::Instant::now();
        let error = output(command, std::time::Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn test_owned_job_kills_player_when_its_guard_is_dropped() {
        use std::os::windows::io::{AsRawHandle, BorrowedHandle};
        use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::WaitForSingleObject;
        let mut command = quiet_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", "media::process::tests::test_child_probe"])
            .env("LILO_MEDIA_PROCESS_TEST_CHILD", "1");
        let child = spawn(command).unwrap();
        let retained = unsafe { BorrowedHandle::borrow_raw(child.as_raw_handle()) }
            .try_clone_to_owned()
            .unwrap();
        drop(child);
        assert_eq!(
            unsafe { WaitForSingleObject(HANDLE(retained.as_raw_handle()), 5_000) },
            WAIT_OBJECT_0
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_windows_media_child_has_no_console() {
        let mut command = quiet_command(std::env::current_exe().unwrap());
        command
            .args(["--exact", "media::process::tests::test_child_probe"])
            .env("LILO_MEDIA_PROCESS_TEST_CHILD", "report");
        let result = output(command, std::time::Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
}

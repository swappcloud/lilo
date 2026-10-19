//! Native Windows launch and field-specific insertion; no shell or global keystrokes.
use super::{read_apps, App, Failure};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, WPARAM},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationValuePattern,
                UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_ValuePatternId,
            },
            Shell::{
                BHID_EnumItems, IEnumShellItems, IShellItem, IShellLinkW,
                SHCreateItemFromParsingName, ShellExecuteW, ShellLink, SIGDN_NORMALDISPLAY,
                SIGDN_PARENTRELATIVEPARSING, SLGP_RAWPATH,
            },
            WindowsAndMessaging::{
                EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
                IsWindowVisible, SendMessageTimeoutW, SetForegroundWindow, ShowWindow,
                SMTO_ABORTIFHUNG, SMTO_BLOCK, SW_RESTORE, SW_SHOWNORMAL,
            },
        },
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self, Failure> {
        // SAFETY: the QuickJS worker owns its COM apartment; balanced by Drop.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|_| Failure::unavailable())?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}
fn executable(pid: u32) -> Option<PathBuf> {
    // SAFETY: a query-only handle and a bounded writable UTF-16 buffer.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(PathBuf::from(
            String::from_utf16(&buffer[..size as usize]).ok()?,
        ))
    }
}
fn process(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}
fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}
fn link_target(path: &std::path::Path) -> Option<PathBuf> {
    // SAFETY: COM is initialized, interface casts are checked, buffers stay live.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        let path = wide(path.to_str()?);
        persist.Load(PCWSTR(path.as_ptr()), STGM_READ).ok()?;
        let mut target = [0u16; 32768];
        link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .ok()?;
        let end = target.iter().position(|c| *c == 0)?;
        if end == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16(&target[..end]).ok()?))
    }
}
fn shell_name(item: &IShellItem, kind: windows::Win32::UI::Shell::SIGDN) -> Option<String> {
    // SAFETY: the shell allocates this UTF-16 string with the COM task allocator.
    let value = unsafe { item.GetDisplayName(kind) }.ok()?;
    let text = unsafe { value.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    text
}

fn packaged_apps() -> Result<Vec<App>, Failure> {
    let root = wide("shell:AppsFolder");
    // SAFETY: this is a fixed OS namespace, not a user-supplied shell expression.
    let folder: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(root.as_ptr()), None) }
        .map_err(|_| Failure::unavailable())?;
    let items: IEnumShellItems = unsafe { folder.BindToHandler(None, &BHID_EnumItems) }
        .map_err(|_| Failure::unavailable())?;
    let mut apps = Vec::new();
    for _ in 0..4096 {
        let mut next = [None];
        // SAFETY: the enumerator writes one owned COM interface into live storage.
        unsafe { items.Next(&mut next, None) }.map_err(|_| Failure::unavailable())?;
        let Some(item) = next[0].take() else { break };
        let Some(identity) = shell_name(&item, SIGDN_PARENTRELATIVEPARSING) else {
            continue;
        };
        // Packaged identities are package-family!application. Classic shortcuts
        // are collected separately so their executable identity remains available.
        if !identity.contains('!') || identity.chars().any(char::is_control) {
            continue;
        }
        let Some(name) = shell_name(&item, SIGDN_NORMALDISPLAY) else {
            continue;
        };
        apps.push(App::new(name, format!("shell:AppsFolder\\{identity}")));
    }
    Ok(apps)
}

pub(super) fn discover() -> Result<Vec<App>, Failure> {
    let _apartment = Apartment::new()?;
    let mut apps = packaged_apps().unwrap_or_default();
    for key in ["ProgramData", "APPDATA"] {
        let Some(root) = std::env::var_os(key) else {
            continue;
        };
        for path in read_apps(
            &PathBuf::from(root).join("Microsoft/Windows/Start Menu/Programs"),
            "lnk",
        ) {
            let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
                continue;
            };
            if apps.iter().any(|app| app.name.eq_ignore_ascii_case(&name)) {
                continue;
            }
            let mut app = App::new(name, &path);
            app.executable = link_target(&path);
            if app.name == "Visual Studio Code" {
                app.aliases.push("vscode".into());
            }
            apps.push(app);
        }
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        for (name, binary, system32) in [
            ("Notepad", "notepad.exe", true),
            ("Calculator", "calc.exe", true),
            ("File Explorer", "explorer.exe", false),
        ] {
            let directory = if system32 {
                PathBuf::from(&root).join("System32")
            } else {
                PathBuf::from(&root)
            };
            let path = directory.join(binary);
            if path.is_file() && !apps.iter().any(|a| a.name.eq_ignore_ascii_case(name)) {
                let mut app = App::new(name, &path);
                app.executable = Some(path);
                apps.push(app);
            }
        }
    }
    Ok(apps)
}
pub(super) fn open(app: &App) -> Result<(), Failure> {
    let _apartment = Apartment::new()?;
    let path = wide(app.path.to_str().ok_or_else(Failure::unavailable)?);
    let verb = wide("open");
    // SAFETY: only a catalog-selected installed shortcut/executable is passed; no arguments.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        Err(Failure::unavailable())
    } else {
        Ok(())
    }
}
struct WindowSearch<'a> {
    executable: &'a std::path::Path,
    found: Option<HWND>,
    ambiguous: bool,
}
unsafe extern "system" fn window_callback(hwnd: HWND, param: LPARAM) -> windows::core::BOOL {
    // SAFETY: EnumWindows is synchronous; LPARAM points to live WindowSearch storage.
    let search = unsafe { &mut *(param.0 as *mut WindowSearch<'_>) };
    if unsafe { IsWindowVisible(hwnd) }.as_bool()
        && executable(process(hwnd)).is_some_and(|p| same_path(&p, search.executable))
    {
        if search.found.is_some() {
            search.ambiguous = true;
        } else {
            search.found = Some(hwnd);
        }
    }
    true.into()
}
pub(super) fn type_text(app: &App, text: &str) -> Result<(), Failure> {
    let _apartment = Apartment::new()?;
    let target = app
        .executable
        .as_ref()
        .ok_or_else(Failure::unsupported_field)?;
    let foreground = unsafe { GetForegroundWindow() };
    let hwnd = if executable(process(foreground)).is_some_and(|p| same_path(&p, target)) {
        foreground
    } else {
        let mut search = WindowSearch {
            executable: target,
            found: None,
            ambiguous: false,
        };
        unsafe {
            EnumWindows(
                Some(window_callback),
                LPARAM(&mut search as *mut _ as isize),
            )
        }
        .map_err(|_| Failure::unavailable())?;
        if search.ambiguous {
            return Err(Failure::new(
                "target_ambiguous",
                "Several target windows are open. Focus the intended window first.",
            ));
        }
        search.found.ok_or_else(|| {
            Failure::new(
                "target_unknown",
                "Open the application and select a text field first.",
            )
        })?
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    while unsafe { GetForegroundWindow() } != hwnd {
        if Instant::now() >= deadline {
            return Err(Failure::new(
                "target_changed",
                "Focus the intended application and try again.",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // SAFETY: apartment initialized; the automation interface is local to this call.
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| Failure::unavailable())?;
    let timeout: IUIAutomation2 = automation.cast().map_err(|_| Failure::unavailable())?;
    unsafe {
        timeout
            .SetConnectionTimeout(1000)
            .and_then(|_| timeout.SetTransactionTimeout(2000))
    }
    .map_err(|_| Failure::unavailable())?;
    let field =
        unsafe { automation.GetFocusedElement() }.map_err(|_| Failure::unsupported_field())?;
    let protected =
        unsafe { field.CurrentIsPassword() }.map_err(|_| Failure::unsupported_field())?;
    if protected.as_bool() {
        return Err(Failure::new(
            "protected_field",
            "Dictation into protected fields is unavailable.",
        ));
    }
    let kind = unsafe { field.CurrentControlType() }.map_err(|_| Failure::unsupported_field())?;
    if ![UIA_EditControlTypeId, UIA_DocumentControlTypeId].contains(&kind)
        || unsafe { field.CurrentProcessId() }.ok() != Some(process(hwnd) as i32)
    {
        return Err(Failure::unsupported_field());
    }
    let current =
        unsafe { automation.GetFocusedElement() }.map_err(|_| Failure::unsupported_field())?;
    if unsafe { GetForegroundWindow() } != hwnd
        || !unsafe { automation.CompareElements(&field, &current) }.is_ok_and(|same| same.as_bool())
    {
        return Err(Failure::new(
            "target_changed",
            "Focus changed before text insertion.",
        ));
    }
    let native =
        unsafe { field.CurrentNativeWindowHandle() }.map_err(|_| Failure::unsupported_field())?;
    let mut name = [0u16; 128];
    let count = unsafe { GetClassNameW(native, &mut name) };
    let class = String::from_utf16_lossy(&name[..count.max(0) as usize]);
    if class.eq_ignore_ascii_case("Edit") || class.to_ascii_lowercase().starts_with("richedit") {
        let text = wide(text);
        let mut result = 0usize;
        // EM_REPLACESEL targets this field only, inserts literal newlines, and supports undo.
        let status = unsafe {
            SendMessageTimeoutW(
                native,
                0x00c2,
                WPARAM(1),
                LPARAM(text.as_ptr() as isize),
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                1000,
                Some(&mut result),
            )
        };
        if status.0 == 0 {
            return Err(Failure::unsupported_field());
        }
        return Ok(());
    }
    // Empty UIA fields can be set without replacing any existing user text.
    let value: IUIAutomationValuePattern = unsafe { field.GetCurrentPatternAs(UIA_ValuePatternId) }
        .map_err(|_| Failure::unsupported_field())?;
    if unsafe { value.CurrentIsReadOnly() }
        .map_err(|_| Failure::unsupported_field())?
        .as_bool()
        || !unsafe { value.CurrentValue() }
            .map_err(|_| Failure::unsupported_field())?
            .is_empty()
    {
        return Err(Failure::unsupported_field());
    }
    let text = windows::core::BSTR::from(text);
    unsafe { value.SetValue(&text) }.map_err(|_| Failure::unsupported_field())
}

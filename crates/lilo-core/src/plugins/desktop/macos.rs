//! App launching and selection insertion through macOS accessibility.
use super::{command, read_apps, App, Failure};
use std::{
    ffi::c_void,
    path::PathBuf,
    time::{Duration, Instant},
};

type Ref = *const c_void;
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFEqual(a: Ref, b: Ref) -> bool;
    fn CFStringCreateWithBytes(
        allocator: Ref,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: bool,
    ) -> Ref;
    fn CFStringGetCString(value: Ref, buffer: *mut i8, size: isize, encoding: u32) -> bool;
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> Ref;
    fn AXUIElementCopyAttributeValue(element: Ref, attr: Ref, value: *mut Ref) -> i32;
    fn AXUIElementSetAttributeValue(element: Ref, attr: Ref, value: Ref) -> i32;
    fn AXUIElementIsAttributeSettable(element: Ref, attr: Ref, settable: *mut bool) -> i32;
    fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
}
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
}

struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
const UTF8: u32 = 0x08000100;
fn string(value: &str) -> Result<Owned, Failure> {
    // SAFETY: the UTF-8 buffer lives through the call; CoreFoundation copies it.
    let ptr = unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            value.as_ptr(),
            value.len() as isize,
            UTF8,
            false,
        )
    };
    if ptr.is_null() {
        Err(Failure::unsupported_field())
    } else {
        Ok(Owned(ptr))
    }
}
fn attr(element: &Owned, name: &str) -> Result<Owned, Failure> {
    let key = string(name)?;
    let mut ptr = std::ptr::null();
    // SAFETY: all references are live CoreFoundation objects; Copy gives owned output.
    let status = unsafe { AXUIElementCopyAttributeValue(element.0, key.0, &mut ptr) };
    if status != 0 || ptr.is_null() {
        Err(Failure::unsupported_field())
    } else {
        Ok(Owned(ptr))
    }
}
fn text_attr(element: &Owned, name: &str) -> Result<String, Failure> {
    let value = attr(element, name)?;
    let mut buffer = [0i8; 256];
    // SAFETY: role attributes are CFStrings and the buffer is writable for its full size.
    if !unsafe { CFStringGetCString(value.0, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) } {
        return Err(Failure::unsupported_field());
    }
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8(bytes).map_err(|_| Failure::unsupported_field())
}
fn pid(element: &Owned) -> Result<i32, Failure> {
    let mut pid = 0;
    // SAFETY: a live AXUIElement and writable process-id storage.
    if unsafe { AXUIElementGetPid(element.0, &mut pid) } != 0 || pid <= 0 {
        Err(Failure::unsupported_field())
    } else {
        Ok(pid)
    }
}
fn belongs_to(app: &App, element: &Owned) -> bool {
    let Ok(pid) = pid(element) else {
        return false;
    };
    let mut buffer = [0u8; 4096];
    // SAFETY: proc_pidpath writes at most the supplied buffer capacity.
    let length = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return false;
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    let Ok(path) = std::str::from_utf8(&buffer[..end]) else {
        return false;
    };
    let Ok(bundle) = app.path.canonicalize() else {
        return false;
    };
    PathBuf::from(path)
        .canonicalize()
        .is_ok_and(|path| path.starts_with(bundle.join("Contents")))
}

pub(super) fn discover() -> Result<Vec<App>, Failure> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    let mut apps = Vec::new();
    let finder = PathBuf::from("/System/Library/CoreServices/Finder.app");
    if finder.is_dir() {
        apps.push(App::new("Finder", finder));
    }
    for root in roots {
        for path in read_apps(&root, "app") {
            let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
                continue;
            };
            let mut app = App::new(name, path);
            if app.name == "Visual Studio Code" {
                app.aliases.push("vscode".into());
            }
            apps.push(app);
        }
    }
    Ok(apps)
}
pub(super) fn open(app: &App) -> Result<(), Failure> {
    let path = app.path.to_str().ok_or_else(Failure::unavailable)?;
    command("/usr/bin/open", &["-a".into(), path.into()]).map(|_| ())
}
pub(super) fn type_text(app: &App, text: &str) -> Result<(), Failure> {
    // SAFETY: AXIsProcessTrusted takes no arguments and only reads authorization.
    if !unsafe { AXIsProcessTrusted() } {
        return Err(Failure::new(
            "permission_denied",
            "Allow LILO in System Settings > Privacy & Security > Accessibility, then try again.",
        ));
    }
    open(app)?;
    // SAFETY: Create returns an owned system-wide accessibility object.
    let system = Owned(unsafe { AXUIElementCreateSystemWide() });
    if system.0.is_null() {
        return Err(Failure::unavailable());
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if attr(&system, "AXFocusedApplication").is_ok_and(|focused| belongs_to(app, &focused)) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(Failure::new(
                "target_changed",
                "The target application did not receive focus.",
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    let field = attr(&system, "AXFocusedUIElement")?;
    if !belongs_to(app, &field) {
        return Err(Failure::new(
            "target_changed",
            "Focus changed. Select the target text field and try again.",
        ));
    }
    if text_attr(&field, "AXSubrole").is_ok_and(|role| role == "AXSecureTextField") {
        return Err(Failure::new(
            "protected_field",
            "Dictation into protected fields is unavailable.",
        ));
    }
    let role = text_attr(&field, "AXRole")?;
    if !["AXTextField", "AXTextArea", "AXComboBox"].contains(&role.as_str()) {
        return Err(Failure::unsupported_field());
    }
    let key = string("AXSelectedText")?;
    let mut settable = false;
    // SAFETY: the field and attribute references remain live for both calls.
    if unsafe { AXUIElementIsAttributeSettable(field.0, key.0, &mut settable) } != 0 || !settable {
        return Err(Failure::unsupported_field());
    }
    let now = attr(&system, "AXFocusedUIElement")?;
    if !unsafe { CFEqual(field.0, now.0) } {
        return Err(Failure::new(
            "target_changed",
            "Focus changed before text insertion.",
        ));
    }
    let value = string(text)?;
    // Setting selected text replaces only the current selection and never presses Enter.
    if unsafe { AXUIElementSetAttributeValue(field.0, key.0, value.0) } != 0 {
        return Err(Failure::unsupported_field());
    }
    Ok(())
}

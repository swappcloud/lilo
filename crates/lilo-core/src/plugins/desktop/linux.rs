//! Desktop entry launch and scoped AT-SPI text insertion over the accessibility bus.
use super::{
    command, normalize, read_apps,
    variant::{numbers, quote, strings},
    App, Failure,
};
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn graphical() -> Result<(), Failure> {
    if ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()))
    {
        Ok(())
    } else {
        Err(Failure::unavailable())
    }
}
fn ordinary_text_role(role: &str) -> bool {
    matches!(normalize(role).as_str(), "text" | "entry" | "documenttext")
}

fn entry(text: &str, key: &str) -> Option<String> {
    let mut active = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            active = line == "[Desktop Entry]";
        }
        if active {
            if let Some((name, value)) = line.split_once('=') {
                if name == key {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}
fn executable(text: &str) -> Option<PathBuf> {
    let exec = entry(text, "TryExec").or_else(|| entry(text, "Exec"))?;
    let binary = if let Some(quoted) = exec.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        exec.split_whitespace().next()?
    };
    if binary.contains('%') {
        return None;
    }
    let path = Path::new(binary);
    if path.is_absolute() {
        return path.canonicalize().ok();
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(binary))
        .find_map(|file| {
            if file.is_file() {
                file.canonicalize().ok()
            } else {
                None
            }
        })
}
pub(super) fn discover() -> Result<Vec<App>, Failure> {
    graphical()?;
    let mut roots = Vec::new();
    let dirs =
        std::env::var_os("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    roots.extend(std::env::split_paths(&dirs).map(|p| p.join("applications")));
    if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
        roots.insert(0, PathBuf::from(home).join("applications"));
    } else if let Some(home) = std::env::var_os("HOME") {
        roots.insert(0, PathBuf::from(home).join(".local/share/applications"));
    }
    let mut apps = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        for path in read_apps(&root, "desktop") {
            let Some(file_name) = path.file_name().map(|s| s.to_owned()) else {
                continue;
            };
            if !seen.insert(file_name) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if entry(&text, "Type").as_deref() != Some("Application")
                || ["Hidden", "NoDisplay"]
                    .iter()
                    .any(|k| entry(&text, k).as_deref() == Some("true"))
            {
                continue;
            }
            let Some(name) = entry(&text, "Name") else {
                continue;
            };
            let mut app = App::new(name, &path);
            app.executable = executable(&text);
            if let Some(class) = entry(&text, "StartupWMClass") {
                app.aliases.push(class);
            }
            if let Some(binary) = app
                .executable
                .as_ref()
                .and_then(|p| p.file_stem())
                .and_then(|s| s.to_str())
            {
                app.aliases.push(binary.into());
            }
            if app.name == "Visual Studio Code" {
                app.aliases.push("vscode".into());
            }
            apps.push(app);
        }
    }
    Ok(apps)
}
pub(super) fn open(app: &App) -> Result<(), Failure> {
    graphical()?;
    let path = app.path.to_str().ok_or_else(Failure::unavailable)?;
    command("gio", &["launch".into(), path.into()]).map(|_| ())
}
#[derive(Clone, Hash, Eq, PartialEq)]
struct Node {
    bus: String,
    path: String,
}
fn call(address: &str, node: &Node, method: &str, args: &[String]) -> Result<String, Failure> {
    let mut argv = vec![
        "call".into(),
        "--address".into(),
        address.into(),
        "--dest".into(),
        node.bus.clone(),
        "--object-path".into(),
        node.path.clone(),
        "--method".into(),
        method.into(),
        "--timeout".into(),
        "1".into(),
        "--".into(),
    ];
    argv.extend_from_slice(args);
    command("gdbus", &argv)
}
fn children(address: &str, node: &Node) -> Result<Vec<Node>, Failure> {
    let result = call(address, node, "org.a11y.atspi.Accessible.GetChildren", &[])?;
    let values = strings(&result).map_err(|_| Failure::unavailable())?;
    Ok(values
        .chunks_exact(2)
        .take(128)
        .filter(|pair| {
            pair[0].starts_with(':')
                && pair[1].starts_with("/org/a11y/atspi/")
                && !pair[1].ends_with("/null")
        })
        .map(|p| Node {
            bus: p[0].clone(),
            path: p[1].clone(),
        })
        .collect())
}
fn property(address: &str, node: &Node, interface: &str, key: &str) -> Result<String, Failure> {
    call(
        address,
        node,
        "org.freedesktop.DBus.Properties.Get",
        &[quote(interface), quote(key)],
    )
}
fn focused(address: &str, node: &Node) -> Result<bool, Failure> {
    let data = call(address, node, "org.a11y.atspi.Accessible.GetState", &[])?;
    let states = numbers(&data);
    if states.len() != 2 {
        return Err(Failure::unsupported_field());
    }
    Ok(states[0] & (1 << 12) != 0 && states[0] & (1 << 7) != 0 && states[0] & (1 << 6) == 0)
}
fn belongs_to(address: &str, node: &Node, app: &App) -> Result<bool, Failure> {
    let dbus = Node {
        bus: "org.freedesktop.DBus".into(),
        path: "/org/freedesktop/DBus".into(),
    };
    let output = call(
        address,
        &dbus,
        "org.freedesktop.DBus.GetConnectionUnixProcessID",
        &[quote(&node.bus)],
    )?;
    let pid = numbers(&output)
        .first()
        .copied()
        .ok_or_else(Failure::unavailable)?;
    let path =
        std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|_| Failure::unsupported_field())?;
    Ok(app.executable.as_ref().is_some_and(|exe| *exe == path))
}
pub(super) fn type_text(app: &App, text: &str) -> Result<(), Failure> {
    graphical()?;
    let address = command(
        "gdbus",
        &[
            "call".into(),
            "--session".into(),
            "--dest".into(),
            "org.a11y.Bus".into(),
            "--object-path".into(),
            "/org/a11y/bus".into(),
            "--method".into(),
            "org.a11y.Bus.GetAddress".into(),
            "--timeout".into(),
            "1".into(),
        ],
    )?;
    let address = strings(&address)
        .map_err(|_| Failure::unavailable())?
        .into_iter()
        .next()
        .ok_or_else(Failure::unavailable)?;
    let root = Node {
        bus: "org.a11y.atspi.Registry".into(),
        path: "/org/a11y/atspi/accessible/root".into(),
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut matches = Vec::new();
    for candidate in children(&address, &root)? {
        if Instant::now() >= deadline {
            return Err(Failure::unavailable());
        }
        let name = property(&address, &candidate, "org.a11y.atspi.Accessible", "Name")?;
        let name = strings(&name)
            .map_err(|_| Failure::unavailable())?
            .into_iter()
            .next()
            .unwrap_or_default();
        if (normalize(&name) == normalize(&app.name)
            || app.aliases.iter().any(|a| normalize(a) == normalize(&name)))
            && belongs_to(&address, &candidate, app)?
        {
            matches.push(candidate);
        }
    }
    let selected = match matches.as_slice() {
        [node] => node.clone(),
        [] => {
            return Err(Failure::new(
                "target_unknown",
                "Open the target application and focus a supported text field first.",
            ))
        }
        _ => {
            return Err(Failure::new(
                "target_ambiguous",
                "Several application instances match. Close extra instances and try again.",
            ))
        }
    };
    let mut queue = VecDeque::from([selected]);
    let mut seen = HashSet::new();
    while let Some(node) = queue.pop_front() {
        if Instant::now() >= deadline || seen.len() >= 256 {
            break;
        }
        if !seen.insert(node.clone()) {
            continue;
        }
        if focused(&address, &node)? {
            let role = call(
                &address,
                &node,
                "org.a11y.atspi.Accessible.GetRoleName",
                &[],
            )?;
            let role = strings(&role)
                .map_err(|_| Failure::unsupported_field())?
                .into_iter()
                .next()
                .unwrap_or_default();
            if normalize(&role) == "passwordtext" {
                return Err(Failure::new(
                    "protected_field",
                    "Dictation into protected fields is unavailable.",
                ));
            }
            if !ordinary_text_role(&role) {
                return Err(Failure::unsupported_field());
            }
            let offset = property(&address, &node, "org.a11y.atspi.Text", "CaretOffset")?;
            let offset = numbers(&offset)
                .first()
                .copied()
                .ok_or_else(Failure::unsupported_field)?;
            if !focused(&address, &node)? || !belongs_to(&address, &node, app)? {
                return Err(Failure::new(
                    "target_changed",
                    "Focus changed before text insertion.",
                ));
            }
            let result = call(
                &address,
                &node,
                "org.a11y.atspi.EditableText.InsertText",
                &[offset.to_string(), quote(text), text.len().to_string()],
            )?;
            return if result.trim() == "(true,)" {
                Ok(())
            } else {
                Err(Failure::unsupported_field())
            };
        }
        queue.extend(children(&address, &node)?);
    }
    Err(Failure::unsupported_field())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_insertion_excludes_terminals_passwords_and_controls() {
        for role in ["text", "entry", "document text"] {
            assert!(ordinary_text_role(role));
        }
        for role in ["terminal", "password text", "push button", "combo box"] {
            assert!(!ordinary_text_role(role));
        }
    }
    #[test]
    fn desktop_entry_uses_only_the_application_section() {
        let source = "[Desktop Entry]\nType=Application\nName=Editor\nExec=editor %F\n[Desktop Action New]\nName=New window\nExec=editor --new\n";
        assert_eq!(entry(source, "Name").as_deref(), Some("Editor"));
        assert_eq!(entry(source, "Exec").as_deref(), Some("editor %F"));
        assert!(entry(source, "TryExec").is_none());
    }
}

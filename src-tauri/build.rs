use std::path::{Path, PathBuf};

fn main() {
    // On macOS `tauri dev` runs the binary *unbundled*, so the usage strings
    // from `bundle.macOS.infoPlist` are missing and TCC aborts the process the
    // moment it touches Speech Recognition (or the mic). Embed the plist as a
    // `__TEXT,__info_plist` section so dev builds carry the usage descriptions
    // too. Bundled/release builds still use the normal Info.plist.
    #[cfg(target_os = "macos")]
    {
        let plist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Info.plist");
        if plist.exists() {
            println!("cargo:rerun-if-changed={}", plist.display());
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                plist.display()
            );
        }
    }

    // The GNU (MinGW) toolchain is the no-admin fallback for machines without
    // MSVC, which Tauri officially requires. Three accommodations make it work.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let windows = target_os == "windows";
    let gnu_windows = windows && target_env != "msvc";
    // `tauri-build` embeds its manifest through `rustc-link-arg-bins`, which
    // reaches the app but not the unit-test harnesses: those link from the
    // library and would fall back to comctl32 v5, which lacks the exports the
    // windowing crates import (STATUS_ENTRYPOINT_NOT_FOUND). Cargo has no
    // stable instruction for unit-test-only link args, so every target gets
    // the manifest instead, and tauri-build's default one is disabled below so
    // the two cannot collide in the bin.
    // Cargo invokes the linker from the workspace root, not this package's
    // directory. Keep the linker argument relative so MSVC does not embed a
    // machine-specific absolute path in the executable.
    let manifest = Path::new("src-tauri/windows").join("app-manifest.xml");
    if windows {
        let manifest_source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows")
            .join("app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest_source.display());
    }
    if windows && !gnu_windows {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        // Keep the linker input relative. MSVC can preserve absolute
        // `/MANIFESTINPUT` arguments in the release executable's debug data.
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    if gnu_windows {
        // MinGW's ld auto-exports the whole symbol table of the `lilo_lib`
        // cdylib and dies once it passes the 16-bit ordinal limit. The cdylib
        // only exists for mobile targets; exporting nothing on desktop is
        // correct.
        println!("cargo:rustc-link-arg=-Wl,--exclude-all-symbols");
        copy_webview2_loader();
        // MinGW ld takes the manifest as a compiled resource; two of them fail
        // with ".rsrc merge failure: multiple non-default manifests".
        if let Some(manifest) = compile_app_manifest() {
            println!("cargo:rustc-link-arg={}", manifest.display());
        }
    }

    // The Claude voice engine runs on claude.ai and reports through this
    // inlined plugin: remote pages may only reach commands a capability grants
    // them, and this one command is all `capabilities/claude-voice.json` grants.
    let mut attributes = tauri_build::Attributes::new()
        .plugin(
            "claude-voice",
            tauri_build::InlinedPlugin::new()
                .commands(&["report"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        )
        .plugin(
            "grok-voice",
            tauri_build::InlinedPlugin::new()
                .commands(&["report"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        );
    if windows {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// The application manifest (comctl32 v6), compiled for the MinGW linker.
///
/// It is linked into *every* target — app and test harnesses alike — and
/// contains what `tauri-build`'s default manifest does.
#[cfg_attr(not(windows), allow(dead_code))]
fn compile_app_manifest() -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows");
    let rc = dir.join("app-manifest.rc");
    let obj = Path::new(&std::env::var("OUT_DIR").ok()?).join("app-manifest.o");
    println!("cargo:rerun-if-changed={}", rc.display());
    let status = std::process::Command::new("windres")
        .current_dir(&dir)
        .arg("-i")
        .arg(&rc)
        .arg("-o")
        .arg(&obj)
        .status()
        .ok()?;
    status.success().then_some(obj)
}

/// With MSVC, `webview2-com-sys` links WebView2Loader statically. With MinGW it
/// links `WebView2Loader.dll`, which therefore has to sit next to the
/// executable. The dependency's build output ships the dll; copy it beside our
/// binary so `cargo run` and `tauri dev` find it.
#[cfg_attr(not(windows), allow(dead_code))]
fn copy_webview2_loader() {
    let Some(profile) = std::env::var("OUT_DIR")
        .ok()
        .and_then(|out| Path::new(&out).ancestors().nth(3).map(Path::to_path_buf))
    else {
        return;
    };
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86") => "x86",
        _ => "x64",
    };
    let Ok(entries) = std::fs::read_dir(profile.join("build")) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("webview2-com-sys-")
        {
            continue;
        }
        let dll = entry
            .path()
            .join("out")
            .join(arch)
            .join("WebView2Loader.dll");
        if dll.is_file() {
            // `tauri dev` runs the binary from the profile dir; test harnesses
            // live in `deps`, and Windows searches the executable's own
            // directory first, so both need a copy.
            let _ = std::fs::copy(&dll, profile.join("WebView2Loader.dll"));
            let _ = std::fs::create_dir_all(profile.join("deps"));
            let _ = std::fs::copy(&dll, profile.join("deps").join("WebView2Loader.dll"));
            break;
        }
    }
}

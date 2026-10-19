//! Getting the box on a network, and bringing up its own when it has none.
//!
//! One trait, one implementation that matters: NetworkManager through `nmcli`,
//! which is what headless Linux distribution ships. It stays behind a trait for the same
//! reason media resolvers do — the setup flow has to be testable without a
//! network, and a second backend later is a new struct, not a rewrite.

use std::process::Command;

/// A network in range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Network {
    pub ssid: String,
    /// 0-100, as `nmcli` reports it.
    pub signal: u8,
    pub secured: bool,
    /// Security protocols reported by NetworkManager (for example `WPA2 WPA3`).
    pub security: Option<String>,
}

/// What the setup window and the normal service need from the OS.
pub trait Wifi: Send + Sync {
    /// Whether this backend can do anything on this machine at all: without it
    /// the box must not pretend it can be configured over the air.
    fn available(&self) -> bool;
    /// Networks in range, strongest first.
    fn scan(&self) -> anyhow::Result<Vec<Network>>;
    /// Join a network. An empty password is what an open network takes.
    fn connect(&self, ssid: &str, password: &str) -> anyhow::Result<()>;
    /// The network the box is on, if any.
    fn current(&self) -> Option<String>;
    /// Bring up the setup access point: open, LAN-only, gone the moment the box
    /// is configured.
    fn start_setup_ap(&self, ssid: &str) -> anyhow::Result<()>;
    /// Take the setup access point down again.
    fn stop_setup_ap(&self) -> anyhow::Result<()>;
    /// Whether this machine has a Wi-Fi radio at all. A wired-only board has
    /// none, and must never be held hostage to a network it cannot join.
    fn has_radio(&self) -> bool;
    /// Whether a usable uplink already exists — Ethernet or a joined Wi-Fi.
    /// The box's own setup access point is never counted.
    fn online(&self) -> bool;
    /// The box's own IPv4 on a real uplink, if any. The phone needs a URL it
    /// can actually reach when there is no access point to join.
    fn local_ip(&self) -> Option<String>;
}

/// The backend a config asks for: `nmcli` (the default) or `fake`.
///
/// `fake` exists for the same reason the app ships a `mock` voice provider: a
/// demo, a test or a machine without a radio still has to show the flow. It
/// never touches the OS.
pub fn backend(name: &str) -> std::sync::Arc<dyn Wifi> {
    match name {
        "fake" => std::sync::Arc::new(Fake::new()),
        _ => std::sync::Arc::new(Nmcli),
    }
}

/// NetworkManager, the backend headless Linux distribution ships.
pub struct Nmcli;

/// The access point's connection name in NetworkManager. `nmcli device wifi
/// hotspot` always creates it under this name.
const HOTSPOT_CONNECTION: &str = "Hotspot";

impl Nmcli {
    fn run(&self, args: &[&str]) -> anyhow::Result<String> {
        let mut child = Command::new("nmcli")
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| anyhow::anyhow!("NetworkManager is unavailable."))?;
        let mut stdout = child.stdout.take().expect("piped stdout");
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            let mut overflow = false;
            loop {
                let count = stdout.read(&mut buffer).unwrap_or(0);
                if count == 0 {
                    break;
                }
                let available = (256 * 1024usize).saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..count.min(available)]);
                overflow |= count > available;
            }
            (bytes, overflow)
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("NetworkManager timed out.");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let status = child.wait()?;
        let (stdout, overflow) = reader
            .join()
            .map_err(|_| anyhow::anyhow!("NetworkManager output failed."))?;
        anyhow::ensure!(!overflow, "NetworkManager response was too large.");
        if !status.success() {
            anyhow::bail!("NetworkManager operation failed.");
        }
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }
}

struct SecretFile(std::path::PathBuf);

impl SecretFile {
    fn new(password: &str) -> anyhow::Result<Self> {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("lilo-wifi-{}.secret", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        writeln!(file, "802-11-wireless-security.psk:{password}")?;
        file.sync_all()?;
        Ok(Self(path))
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap_or("")
    }
}

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod secret_tests {
    use super::SecretFile;

    #[test]
    fn nmcli_secret_is_private_and_removed_after_use() {
        let secret = SecretFile::new("fixture-password").unwrap();
        let path = secret.0.clone();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "802-11-wireless-security.psk:fixture-password\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(secret);
        assert!(!path.exists());
    }
}

impl Wifi for Nmcli {
    fn available(&self) -> bool {
        self.run(&["--version"]).is_ok()
    }

    fn scan(&self) -> anyhow::Result<Vec<Network>> {
        let output = self.run(&["-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"])?;
        let mut networks: Vec<Network> = output.lines().filter_map(parse_scan_line).collect();
        // `nmcli` prints in its own order; the page wants the strong ones first.
        networks.sort_by_key(|network| std::cmp::Reverse(network.signal));
        networks.dedup_by(|a, b| a.ssid == b.ssid);
        Ok(networks)
    }

    fn connect(&self, ssid: &str, password: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !ssid.is_empty() && ssid.len() <= 32 && !ssid.chars().any(char::is_control),
            "Invalid Wi-Fi network name."
        );
        anyhow::ensure!(
            password.len() <= 128 && !password.chars().any(char::is_control),
            "Invalid Wi-Fi password."
        );
        let connection = format!("lilo-{}", uuid::Uuid::new_v4().simple());
        if password.is_empty() {
            self.run(&[
                "connection",
                "add",
                "type",
                "wifi",
                "con-name",
                &connection,
                "ssid",
                ssid,
            ])?;
            self.run(&["connection", "up", &connection])?;
        } else {
            let secret = SecretFile::new(password)?;
            self.run(&[
                "connection",
                "add",
                "type",
                "wifi",
                "con-name",
                &connection,
                "ssid",
                ssid,
                "wifi-sec.key-mgmt",
                "wpa-psk",
            ])?;
            self.run(&[
                "connection",
                "up",
                &connection,
                "passwd-file",
                secret.path(),
            ])?;
        }
        Ok(())
    }

    fn current(&self) -> Option<String> {
        let output = self
            .run(&["-t", "-f", "ACTIVE,SSID", "device", "wifi"])
            .ok()?;
        output.lines().find_map(parse_current_line)
    }

    fn start_setup_ap(&self, ssid: &str) -> anyhow::Result<()> {
        // An open network on purpose: the page must open without a keyboard, and
        // it only exists until an account is stored (docs/command-protocol.md
        // §9). NetworkManager's shared mode hands out addresses and NATs
        // nothing — there is no uplink until the user picks one.
        self.run(&["device", "wifi", "hotspot", "ssid", ssid])?;
        Ok(())
    }

    fn stop_setup_ap(&self) -> anyhow::Result<()> {
        // Deleted, not just brought down: a saved "Hotspot" connection would be
        // reactivated on the next boot.
        let _ = self.run(&["connection", "down", HOTSPOT_CONNECTION]);
        let _ = self.run(&["connection", "delete", HOTSPOT_CONNECTION]);
        Ok(())
    }

    fn has_radio(&self) -> bool {
        self.run(&["-t", "-f", "DEVICE,TYPE", "device", "status"])
            .map(|output| parse_has_radio(&output))
            .unwrap_or(true) // unknown -> assume a radio, never unblock by accident
    }

    fn online(&self) -> bool {
        // Strict internet first, then "an active connection that is not our own
        // access point". The second step is what makes Ethernet, a LAN-only link
        // and a disabled connectivity check all count as already-online.
        let full = self
            .run(&["-t", "-f", "CONNECTIVITY", "general", "status"])
            .map(|output| parse_connectivity(&output) == Connectivity::Full)
            .unwrap_or(false);
        if full {
            return true;
        }
        self.run(&["-t", "-f", "NAME", "connection", "show", "--active"])
            .map(|output| parse_active_uplink(&output))
            .unwrap_or(false)
    }

    fn local_ip(&self) -> Option<String> {
        // Read before the setup access point is brought up, so the first real
        // address is the uplink's and never the AP's own 192.168.4.1. `ip`/`iw`
        // are not installed on the target board, so nmcli is the only source.
        let output = self
            .run(&["-t", "-g", "IP4.ADDRESS", "device", "show"])
            .ok()?;
        output.lines().find_map(parse_ip4_address)
    }
}

/// A radio that is not there: fixed networks, a join that always works.
///
/// Selected by `[setup] wifi = "fake"`; the networks are the ones a demo can
/// show, and `connect` remembers the SSID so the page's second step has a
/// network to be on.
pub struct Fake {
    networks: Vec<Network>,
    joined: std::sync::Mutex<Option<String>>,
    radio: bool,
    online: bool,
    lan_ip: Option<String>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            networks: vec![
                Network {
                    ssid: "casa".to_string(),
                    signal: 82,
                    secured: true,
                    security: Some("WPA2".to_string()),
                },
                Network {
                    ssid: "visitantes".to_string(),
                    signal: 47,
                    secured: false,
                    security: None,
                },
            ],
            joined: std::sync::Mutex::new(None),
            radio: true,
            online: false,
            lan_ip: None,
        }
    }

    /// A board with no Wi-Fi radio: it can never join, so setup must not wait
    /// for a join (`network_ok` clause (c)). Test-only, like the builders below:
    /// the daemon's real backend is `Nmcli`.
    #[cfg(test)]
    pub fn radio_less(mut self) -> Self {
        self.radio = false;
        self
    }

    /// A box that already has a usable uplink (`network_ok` clause (b)).
    #[cfg(test)]
    pub fn online(mut self) -> Self {
        self.online = true;
        self
    }

    /// Explicitly offline; the default, spelled out so tests read as intent.
    #[cfg(test)]
    pub fn offline(mut self) -> Self {
        self.online = false;
        self
    }

    /// An address to report on the uplink, for URL tests.
    #[cfg(test)]
    pub fn with_ip(mut self, ip: &str) -> Self {
        self.lan_ip = Some(ip.to_string());
        self
    }
}

impl Default for Fake {
    fn default() -> Self {
        Self::new()
    }
}

impl Wifi for Fake {
    fn available(&self) -> bool {
        true
    }

    fn scan(&self) -> anyhow::Result<Vec<Network>> {
        Ok(self.networks.clone())
    }

    fn connect(&self, ssid: &str, _password: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !ssid.is_empty() && ssid.len() <= 32,
            "Invalid Wi-Fi network name."
        );
        if !self.networks.iter().any(|network| network.ssid == ssid) {
            anyhow::bail!("no network called {ssid}");
        }
        *self.joined.lock().unwrap() = Some(ssid.to_string());
        Ok(())
    }

    fn current(&self) -> Option<String> {
        self.joined.lock().unwrap().clone()
    }

    fn start_setup_ap(&self, _ssid: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn stop_setup_ap(&self) -> anyhow::Result<()> {
        Ok(())
    }

    fn has_radio(&self) -> bool {
        self.radio
    }

    fn online(&self) -> bool {
        self.online
    }

    fn local_ip(&self) -> Option<String> {
        self.lan_ip.clone()
    }
}

/// What `nmcli -t -f CONNECTIVITY general status` reports, as a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Connectivity {
    Full,
    Limited,
    Portal,
    None,
    Unknown,
}

/// `nmcli -t -f CONNECTIVITY general status` -> the terse word.
///
/// Anything that is not one of nmcli's known values (empty output, a locale we
/// do not know) is `Unknown`, which falls through to the active-connection
/// check in `Nmcli::online`.
pub fn parse_connectivity(output: &str) -> Connectivity {
    match output.trim() {
        "full" => Connectivity::Full,
        "limited" => Connectivity::Limited,
        "portal" => Connectivity::Portal,
        "none" => Connectivity::None,
        _ => Connectivity::Unknown,
    }
}

/// `nmcli -t -f DEVICE,TYPE device status` -> does any row name a `wifi` device?
///
/// A successful `device status` always lists at least `lo:loopback`, so "no
/// usable row at all" means the output could not be read; that is reported as
/// `true` (assume a radio). The Nmcli caller keeps the same fail-safe direction
/// for the error case, so a parsing surprise never silently unblocks the gate.
pub fn parse_has_radio(output: &str) -> bool {
    let mut saw_device = false;
    for line in output.lines() {
        let fields = split_escaped(line);
        // `DEVICE,TYPE` is exactly two columns; anything else is not a row.
        if fields.len() != 2 {
            continue;
        }
        let (device, kind) = (fields[0].trim(), fields[1].trim());
        if device.is_empty() || kind.is_empty() {
            continue;
        }
        saw_device = true;
        if kind == "wifi" {
            return true;
        }
    }
    !saw_device
}

/// `nmcli -t -f NAME connection show --active` -> is a real uplink active?
///
/// True when any active connection is not the box's own setup access point:
/// that covers Ethernet, a LAN-only link and a captive portal. `lo` never shows
/// up here — NetworkManager does not manage the loopback as a connection.
pub fn parse_active_uplink(output: &str) -> bool {
    output.lines().any(|line| {
        let name = split_escaped(line)
            .first()
            .map(|name| name.trim().to_string())
            .unwrap_or_default();
        !name.is_empty() && name != HOTSPOT_CONNECTION
    })
}

/// One line of `nmcli -t -g IP4.ADDRESS device show` -> a usable IPv4 address.
///
/// `-g` may print a bare `192.168.1.4/24` or a `IP4.ADDRESS[1]:192.168.1.4/24`
/// field depending on the nmcli version; IPv4 has no colon of its own, so the
/// last colon-separated piece is the value either way. Loopback and link-local
/// addresses are never the uplink.
fn parse_ip4_address(line: &str) -> Option<String> {
    let value = line.rsplit(':').next().unwrap_or(line).trim();
    let address = value.split('/').next().unwrap_or(value).trim();
    if address.is_empty() || address.starts_with("127.") || address.starts_with("169.254.") {
        return None;
    }
    Some(address.to_string())
}

/// One line of `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list`.
///
/// `-t` (terse) escapes a colon inside a value as `\:`, and an open network has
/// an empty security field — SSIDs are user data, so neither may be guessed.
pub fn parse_scan_line(line: &str) -> Option<Network> {
    let fields = split_escaped(line);
    let ssid = fields.first()?.trim().to_string();
    if ssid.is_empty() {
        return None; // hidden network: nothing to show, nothing to join
    }
    let signal = fields
        .get(1)
        .and_then(|value| value.trim().parse::<u8>().ok())
        .unwrap_or(0)
        .min(100);
    let security = fields
        .get(2)
        .map(|security| security.trim().to_string())
        .filter(|security| !security.is_empty() && security != "--");
    let secured = security.is_some();
    Some(Network {
        ssid,
        signal,
        secured,
        security,
    })
}

/// One line of `nmcli -t -f ACTIVE,SSID device wifi`.
pub fn parse_current_line(line: &str) -> Option<String> {
    let fields = split_escaped(line);
    let active = fields.first()?.trim();
    let ssid = fields.get(1)?.trim();
    (active == "yes" && !ssid.is_empty()).then(|| ssid.to_string())
}

/// Split on `:` while honouring `nmcli -t`'s `\:` escapes.
fn split_escaped(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars();
    while let Some(character) = chars.next() {
        match character {
            '\\' => {
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                }
            }
            ':' => {
                fields.push(std::mem::take(&mut current));
            }
            other => current.push(other),
        }
    }
    fields.push(current);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scan_line_becomes_a_network() {
        let network = parse_scan_line("home-wifi:74:WPA2").expect("a network");
        assert_eq!(network.ssid, "home-wifi");
        assert_eq!(network.signal, 74);
        assert!(network.secured);
    }

    #[test]
    fn an_open_network_has_no_security() {
        let network = parse_scan_line("visitantes:31:").expect("a network");
        assert!(!network.secured, "empty security means open");
        assert_eq!(network.signal, 31);
    }

    #[test]
    fn a_colon_inside_an_ssid_survives() {
        let network = parse_scan_line(r"casa\: de novo:55:WPA1 WPA2").expect("a network");
        assert_eq!(network.ssid, "casa: de novo");
        assert!(network.secured);
    }

    #[test]
    fn a_hidden_network_is_skipped() {
        assert!(parse_scan_line(":0:").is_none());
        assert!(parse_scan_line("").is_none());
    }

    #[test]
    fn only_the_active_line_names_the_current_network() {
        assert_eq!(
            parse_current_line("yes:home-wifi").as_deref(),
            Some("home-wifi")
        );
        assert!(parse_current_line("no:home-wifi").is_none());
        assert!(parse_current_line("yes:").is_none());
    }

    #[test]
    fn a_wifi_row_means_the_board_has_a_radio() {
        assert!(
            !parse_has_radio("eth0:ethernet\nlo:loopback"),
            "a wired-only board has no radio"
        );
        assert!(parse_has_radio("eth0:ethernet\nwlan0:wifi"));
    }

    #[test]
    fn an_unreadable_device_list_is_treated_as_having_a_radio() {
        assert!(parse_has_radio(""), "empty output is not a device list");
        assert!(parse_has_radio("garbage"), "no device rows at all");
        assert!(
            parse_has_radio("not:a:device:list"),
            "three columns is not DEVICE,TYPE"
        );
    }

    #[test]
    fn connectivity_full_is_online() {
        assert_eq!(parse_connectivity("full\n"), Connectivity::Full);
        assert_ne!(parse_connectivity("limited"), Connectivity::Full);
        assert_ne!(parse_connectivity("portal"), Connectivity::Full);
        assert_ne!(parse_connectivity("none"), Connectivity::Full);
        assert_ne!(parse_connectivity("unknown"), Connectivity::Full);
        assert_eq!(parse_connectivity(""), Connectivity::Unknown);
    }

    #[test]
    fn a_real_active_connection_counts_but_the_hotspot_does_not() {
        assert!(parse_active_uplink("Wired connection 1\n"));
        assert!(
            !parse_active_uplink("Hotspot\n"),
            "our own AP is not an uplink"
        );
        assert!(!parse_active_uplink(""));
    }

    #[test]
    fn fake_simulates_radio_online_and_offline() {
        let plain: &dyn Wifi = &Fake::new();
        assert!(plain.has_radio(), "the default fake has a radio");
        assert!(!plain.online(), "and starts offline");

        let radio_less: &dyn Wifi = &Fake::new().radio_less();
        assert!(!radio_less.has_radio());

        let online: &dyn Wifi = &Fake::new().online();
        assert!(online.online());

        let offline: &dyn Wifi = &Fake::new().offline();
        assert!(!offline.online());

        let addressed: &dyn Wifi = &Fake::new().with_ip("192.168.1.4");
        assert_eq!(addressed.local_ip().as_deref(), Some("192.168.1.4"));
    }
}

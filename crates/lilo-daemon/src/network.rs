//! Paired phone operations for safe Wi-Fi discovery and joining.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, ensure};
use serde::Serialize;

use crate::wifi::{Network, Wifi};

const SCAN_MAX_AGE: Duration = Duration::from_secs(300);
const MAX_NETWORKS: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub available: bool,
    pub has_radio: bool,
    pub online: bool,
    pub current_ssid: Option<String>,
    pub local_ip: Option<String>,
    pub can_scan: bool,
    pub can_join: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedNetwork {
    pub ssid: String,
    pub signal: u8,
    pub security: Option<String>,
    pub secured: bool,
}

impl From<Network> for ScannedNetwork {
    fn from(network: Network) -> Self {
        Self {
            ssid: network.ssid,
            signal: network.signal,
            security: network.security,
            secured: network.secured,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkScan {
    pub networks: Vec<ScannedNetwork>,
}

pub struct NetworkController {
    wifi: Arc<dyn Wifi>,
    scanned: Mutex<Option<(Instant, Vec<Network>)>>,
}

impl NetworkController {
    pub fn new(wifi: Arc<dyn Wifi>) -> Self {
        Self {
            wifi,
            scanned: Mutex::new(None),
        }
    }

    pub fn status(&self) -> NetworkStatus {
        let available = self.wifi.available();
        let has_radio = available && self.wifi.has_radio();
        NetworkStatus {
            available,
            has_radio,
            online: self.wifi.online(),
            current_ssid: self.wifi.current(),
            local_ip: self.wifi.local_ip(),
            can_scan: has_radio,
            can_join: has_radio,
        }
    }

    pub fn scan(&self) -> anyhow::Result<NetworkScan> {
        ensure!(
            self.status().can_scan,
            "Wi-Fi management is unavailable on this device."
        );
        let mut networks = self.wifi.scan()?;
        networks.retain(|network| valid_ssid(&network.ssid));
        networks.truncate(MAX_NETWORKS);
        *self
            .scanned
            .lock()
            .map_err(|_| anyhow::anyhow!("Wi-Fi state is unavailable."))? =
            Some((Instant::now(), networks.clone()));
        Ok(NetworkScan {
            networks: networks.into_iter().map(ScannedNetwork::from).collect(),
        })
    }

    pub fn join(&self, ssid: &str, password: &str) -> anyhow::Result<NetworkStatus> {
        ensure!(
            self.status().can_join,
            "Wi-Fi management is unavailable on this device."
        );
        ensure!(valid_ssid(ssid), "Invalid Wi-Fi network name.");
        ensure!(
            password.len() <= 128 && !password.chars().any(char::is_control),
            "Invalid Wi-Fi password."
        );
        let scanned = self
            .scanned
            .lock()
            .map_err(|_| anyhow::anyhow!("Wi-Fi state is unavailable."))?;
        let Some((at, networks)) = scanned.as_ref() else {
            bail!("Scan for networks before joining.")
        };
        ensure!(
            at.elapsed() <= SCAN_MAX_AGE,
            "Scan for networks before joining."
        );
        let Some(network) = networks.iter().find(|network| network.ssid == ssid) else {
            bail!("Choose a network from the scan results.")
        };
        if network.secured {
            let passphrase = (8..=63).contains(&password.len());
            let raw_psk =
                password.len() == 64 && password.bytes().all(|byte| byte.is_ascii_hexdigit());
            ensure!(
                passphrase || raw_psk,
                "Wi-Fi password must be 8 to 63 characters or a 64-character hexadecimal key."
            );
        } else {
            ensure!(password.is_empty(), "This network does not use a password.");
        }
        drop(scanned);
        self.wifi
            .connect(ssid, password)
            .map_err(|_| anyhow::anyhow!("Could not join that Wi-Fi network."))?;
        Ok(self.status())
    }
}

fn valid_ssid(ssid: &str) -> bool {
    !ssid.is_empty() && ssid.len() <= 32 && !ssid.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wifi::Fake;

    #[test]
    fn no_radio_hides_scan_and_join_capabilities_but_reports_uplink() {
        let controller = NetworkController::new(Arc::new(Fake::new().radio_less().online()));
        let status = controller.status();
        assert!(!status.has_radio && status.online && !status.can_scan && !status.can_join);
        assert!(controller.scan().is_err());
    }

    #[test]
    fn joins_only_a_recent_scanned_network_and_never_echoes_password() {
        let controller = NetworkController::new(Arc::new(Fake::new()));
        assert!(controller.join("casa", "correct horse battery").is_err());
        let scan = controller.scan().unwrap();
        assert_eq!(scan.networks[0].security.as_deref(), Some("WPA2"));
        let error = controller
            .join("unknown", "secret-pass")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-pass"));
        assert!(controller.join("casa", "secret-pass").is_ok());
        assert!(controller.join("visitantes", "secret-pass").is_err());
    }
}

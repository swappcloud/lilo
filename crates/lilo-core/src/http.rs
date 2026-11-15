//! Shared TLS initialization for desktop, daemon and plugins.
//! Keep ring as the provider when upgrading reqwest, without pulling AWS-LC
//! and its additional native build toolchain onto small headless targets.
pub fn builder() -> reqwest::ClientBuilder {
    static INITIALIZED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    INITIALIZED.get_or_init(|| {
        // Another host component may already have installed a valid provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::builder()
}

pub fn client() -> reqwest::Client {
    builder().build().expect("HTTP client initialization")
}

#[cfg(test)]
mod tests {
    #[test]
    fn initializes_tls_before_building_clients() {
        let _ = super::client();
        let _ = super::builder().build().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}

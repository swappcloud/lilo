//! Authenticated, bounded HTTP transport to the optional local browser broker.

use anyhow::{ensure, Context};
use serde_json::Value;
use std::{path::Path, time::Duration};

#[derive(Clone)]
pub struct BrokerClient {
    endpoint: String,
    token: String,
    client: reqwest::Client,
}

impl BrokerClient {
    pub fn connect(endpoint: &str, token_file: &Path) -> anyhow::Result<Self> {
        let url = reqwest::Url::parse(endpoint)?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Invalid browser-host address."
        );
        let token = std::fs::read_to_string(token_file)
            .context("Browser-host token file is unavailable.")?;
        ensure!(
            token.trim().len() == 64 && token.trim().bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Invalid browser-host token."
        );
        Ok(Self {
            endpoint: endpoint.trim_end_matches('/').into(),
            token: token.trim().into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }

    pub async fn get(&self, path: &str) -> anyhow::Result<Value> {
        let response = self
            .client
            .get(format!("{}{}", self.endpoint, path))
            .header("X-Lilo-Browser-Token", &self.token)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Browser host is unavailable."))?;
        Self::bounded(response).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> anyhow::Result<Value> {
        let response = self
            .client
            .post(format!("{}{}", self.endpoint, path))
            .header("X-Lilo-Browser-Token", &self.token)
            .timeout(Duration::from_secs(if path == "/voice" { 75 } else { 45 }))
            .json(body)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Browser host is unavailable."))?;
        Self::bounded(response).await
    }

    async fn bounded(mut response: reqwest::Response) -> anyhow::Result<Value> {
        ensure!(response.status().is_success(), "Browser request failed.");
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Browser response failed."))?
        {
            ensure!(
                bytes.len() + chunk.len() <= 768 * 1024,
                "Browser response is too large."
            );
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).context("Invalid browser response.")
    }
}

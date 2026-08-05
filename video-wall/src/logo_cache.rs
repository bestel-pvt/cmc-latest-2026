//! Channel-logo fetcher + in-memory cache.
//!
//! Called by the UI layer to populate the side-panel channel list.
//! Runs on the tokio runtime; the UI hands out a `LogoHandle` which
//! resolves once the bytes are downloaded, so the render thread never
//! blocks on HTTP.

use anyhow::Result;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct LogoCache {
    inner: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>,
    http: Client,
    api_base: String,
    token: Option<String>,
}

impl LogoCache {
    pub fn new(api_base: impl Into<String>, token: Option<String>) -> Result<Self> {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            http,
            api_base: api_base.into().trim_end_matches('/').to_string(),
            token,
        })
    }

    /// Look up bytes for a channel-id. On cache miss, fetches
    /// `GET /api/channels/{id}/logo` with bearer auth and caches
    /// the result. Returns None if the download fails so the caller
    /// can render a fallback (name-initials monogram).
    pub async fn get(&self, channel_id: &str) -> Option<Arc<Vec<u8>>> {
        if let Some(v) = self.inner.lock().ok().and_then(|c| c.get(channel_id).cloned()) {
            return Some(v);
        }
        let url = format!("{}/api/channels/{channel_id}/logo", self.api_base);
        let mut headers = HeaderMap::new();
        if let Some(t) = &self.token {
            if let Ok(v) = HeaderValue::from_str(&format!("Bearer {t}")) {
                headers.insert(AUTHORIZATION, v);
            }
        }
        let resp = self.http.get(&url).headers(headers).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let bytes = resp.bytes().await.ok()?.to_vec();
        let arc = Arc::new(bytes);
        if let Ok(mut c) = self.inner.lock() {
            c.insert(channel_id.to_string(), arc.clone());
        }
        Some(arc)
    }
}

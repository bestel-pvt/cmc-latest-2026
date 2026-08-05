//! CMC HTTP API client — parity port of the Python `api.py` file.
//!
//! Only the subset the viewer actually calls:
//!   - POST /api/auth/login  (email + password → { accessToken })
//!   - GET  /api/channels   (bearer-authenticated channel list)
//!
//! Logo download is deferred to the UI layer since it's async +
//! cache-heavy — same split as the Python code (`_fetch_logo_image`).

use anyhow::{anyhow, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

/// One playable source (satellite, backup UDP, RTSP, …).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Source {
    pub id: String,
    pub kind: String, // UDP | RTP | RTSP | SRT
    pub url: String,
    #[serde(rename = "isPrimary", default)]
    pub is_primary: bool,
}

/// One TV channel with its sources + CMC-generated rebroadcast URL.
///
/// Only the UDP multicast rebroadcast is emitted server-side — the
/// video wall joins that group directly. There is no MediaMTX / RTSP
/// hop; a source with `kind == "RTSP"` remains an INPUT the operator
/// configured (satellite backup, IPTV) and is played straight from
/// its own URL.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub slug: String,
    #[serde(rename = "logoUrl", default)]
    pub logo_url: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default = "default_true")]
    pub online: bool,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(rename = "dempOutputUrl", default)]
    pub demp_udp_url: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Channel {
    /// Pick the best URL for playback given the caller's multicast
    /// NIC preference. Primary-flagged UDP/RTP source first, then any
    /// UDP/RTP source, then the CMC-side UDP rebroadcast, then whatever
    /// source is first in the list (RTSP / SRT / …) as a last resort.
    pub fn primary_url(&self, localaddr: &str) -> Option<String> {
        for s in &self.sources {
            if s.is_primary && matches!(s.kind.to_uppercase().as_str(), "UDP" | "RTP") {
                return Some(vlc_style_url(&s.url, &s.kind, localaddr));
            }
        }
        for s in &self.sources {
            if matches!(s.kind.to_uppercase().as_str(), "UDP" | "RTP") {
                return Some(vlc_style_url(&s.url, &s.kind, localaddr));
            }
        }
        if let Some(u) = &self.demp_udp_url {
            return Some(u.clone());
        }
        self.sources.first().map(|s| vlc_style_url(&s.url, &s.kind, localaddr))
    }
}

/// Rewrite a raw satellite UDP URL into one GStreamer will accept —
/// same shape as the VLC helper: `udp://host:port` → `udp://@host:port`
/// so the socket is opened in "listen for multicast" mode, and append
/// `?localaddr=NIC` on hosts with multiple NICs.
fn vlc_style_url(url: &str, kind: &str, localaddr: &str) -> String {
    let mut u = url.trim().to_string();
    let upper = kind.to_uppercase();
    if upper == "UDP" || upper == "RTP" {
        if let Some((proto, rest)) = u.split_once("://") {
            if !rest.starts_with('@') {
                u = format!("{}://@{}", proto.to_lowercase(), rest);
            }
        }
        if !localaddr.is_empty() {
            let sep = if u.contains('?') { '&' } else { '?' };
            u = format!("{u}{sep}localaddr={localaddr}");
        }
    }
    u
}

#[derive(Serialize)]
struct LoginBody<'a> {
    email: &'a str,
    password: &'a str,
}

#[derive(Deserialize)]
struct LoginResp {
    #[serde(rename = "accessToken")]
    access_token: String,
}

/// Thin API client that holds the bearer token between calls.
pub struct CmcClient {
    base: String,
    http: Client,
    token: Option<String>,
}

impl CmcClient {
    pub fn new(base_url: impl Into<String>) -> Result<Self> {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .context("build reqwest client")?;
        Ok(Self { base: base_url.into().trim_end_matches('/').to_string(), http, token: None })
    }

    pub fn set_token(&mut self, token: Option<String>) {
        self.token = token;
    }

    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(ACCEPT, HeaderValue::from_static("application/json"));
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(t) = &self.token {
            if let Ok(v) = HeaderValue::from_str(&format!("Bearer {t}")) {
                h.insert(AUTHORIZATION, v);
            }
        }
        h
    }

    /// POST /api/auth/login — stores the returned JWT on success.
    pub async fn login(&mut self, email: &str, password: &str) -> Result<String> {
        let resp = self
            .http
            .post(format!("{}/api/auth/login", self.base))
            .headers(self.headers())
            .json(&LoginBody { email, password })
            .send()
            .await
            .context("POST /api/auth/login")?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err(anyhow!("Wrong email or password"));
        }
        if !resp.status().is_success() {
            return Err(anyhow!("HTTP {}", resp.status()));
        }
        let body: LoginResp = resp.json().await.context("parse login response")?;
        self.token = Some(body.access_token.clone());
        Ok(body.access_token)
    }

    /// GET /api/channels — returns the full channel list with sources.
    pub async fn list_channels(&self) -> Result<Vec<Channel>> {
        let resp = self
            .http
            .get(format!("{}/api/channels", self.base))
            .headers(self.headers())
            .send()
            .await
            .context("GET /api/channels")?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            return Err(anyhow!("Session expired — please sign in again"));
        }
        if !resp.status().is_success() {
            return Err(anyhow!("HTTP {}", resp.status()));
        }
        let channels: Vec<Channel> = resp.json().await.context("parse channels response")?;
        Ok(channels)
    }
}

#[cfg(test)]
mod tests {
    use super::vlc_style_url;

    #[test]
    fn udp_gets_at_prefix_and_localaddr() {
        let u = vlc_style_url("udp://239.1.1.5:1111", "UDP", "10.51.80.202");
        assert_eq!(u, "udp://@239.1.1.5:1111?localaddr=10.51.80.202");
    }

    #[test]
    fn already_at_prefixed_is_untouched() {
        let u = vlc_style_url("udp://@239.1.1.5:1111", "UDP", "");
        assert_eq!(u, "udp://@239.1.1.5:1111");
    }

    #[test]
    fn rtsp_is_passthrough() {
        // RTSP is still a valid INPUT source kind (operator-configured
        // IPTV or backup URL). vlc_style_url must leave it untouched.
        let u = vlc_style_url("rtsp://iptv.example.tld/live/dunya-news", "RTSP", "10.51.80.202");
        assert_eq!(u, "rtsp://iptv.example.tld/live/dunya-news");
    }
}

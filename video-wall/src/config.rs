//! On-disk user configuration.
//!
//! Stored at `%APPDATA%\CMC-VideoWall\config.json` — a NEW folder
//! separate from the Python viewer's `%APPDATA%\CMC-Viewer\` so both
//! exes can run side-by-side without stomping on each other during
//! the migration.
//!
//! Field names match the Python `Config` dataclass so the two viewers
//! can share a schema and (later) migrate settings from one to the
//! other with a single copy.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Per-channel fill behaviour. Matches the Python `fill_modes` map.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FillMode {
    /// Force the tile's pixel aspect — small distortion on 4:3 sources
    /// but fills the whole tile.
    Stretch,
    /// Crop the source to tile aspect (removes baked pillar/letter
    /// bars; no distortion).
    Crop,
    /// Preserve source aspect; let-/pillar-box to fit the tile.
    Fit,
}

impl Default for FillMode {
    fn default() -> Self {
        FillMode::Stretch
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Config {
    /// Base URL for the CMC API — e.g. `http://10.51.80.202:4001`.
    #[serde(default = "default_api_base")]
    pub api_base: String,

    /// Last-used email pre-filled into the login form.
    #[serde(default)]
    pub email: String,

    /// Cached JWT — lets the viewer skip the login screen on relaunch
    /// until it expires or the API rejects it.
    #[serde(default)]
    pub access_token: Option<String>,

    /// Local NIC IPv4 to bind multicast joins to. Needed on hosts
    /// with multiple NICs so IGMP joins land on the right interface.
    #[serde(default)]
    pub multicast_localaddr: String,

    /// Layout id currently selected (`"grid32"`, `"mosaic"`, etc.).
    #[serde(default = "default_layout")]
    pub layout: String,

    /// Per-layout channel-id assignments:
    ///   { "grid32": [id, "", id, …], "mosaic": [id, …], … }
    #[serde(default)]
    pub layout_slots: HashMap<String, Vec<String>>,

    /// When true, empty slots in fullscreen are auto-filled by cycling
    /// through the channel list (unassigned first, then duplicates).
    #[serde(default = "default_true")]
    pub auto_fill_empty_slots: bool,

    /// Per-channel fill mode keyed by `channel.slug`.
    #[serde(default)]
    pub fill_modes: HashMap<String, FillMode>,
}

fn default_api_base() -> String {
    "http://10.51.80.202:4001".to_string()
}
fn default_layout() -> String {
    "grid32".to_string()
}
fn default_true() -> bool {
    true
}

/// Directory that holds the config file. Created on first use.
pub fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("CMC-VideoWall")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

impl Config {
    /// Load config from disk. Missing file or malformed JSON returns
    /// defaults — the same forgiving behaviour as the Python loader.
    pub fn load() -> Self {
        let path = config_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .unwrap_or_default()
    }

    /// Pretty-print to `%APPDATA%\CMC-VideoWall\config.json`.
    pub fn save(&self) -> Result<()> {
        let dir = config_dir();
        std::fs::create_dir_all(&dir)?;
        let path = config_path();
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, json)?;
        Ok(())
    }

    pub fn get_fill_mode(&self, slug: &str) -> FillMode {
        self.fill_modes.get(slug).copied().unwrap_or_default()
    }

    pub fn set_fill_mode(&mut self, slug: &str, mode: FillMode) {
        self.fill_modes.insert(slug.to_string(), mode);
    }
}

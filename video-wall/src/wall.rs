//! The Wall — manages N tiles for a given Layout, handles auto-fill
//! for empty slots, and reshuffles tiles when the operator switches
//! layout or when the parent window resizes.
//!
//! The wall does NOT own the event loop or the chrome UI (toolbar,
//! channel list, login) — those live in `ui.rs` / `main.rs`. This
//! file just knows about slots, tiles, and their lifecycle.

use anyhow::Result;
use winit::event_loop::ActiveEventLoop;

use crate::api::Channel;
use crate::config::{Config, FillMode};
use crate::layouts::{by_id as layout_by_id, Layout, Slot};
use crate::tile::Tile;

pub struct Wall {
    /// The catalogue of every channel the API returned. Copied so the
    /// wall can auto-fill empty slots without asking the API each time.
    channels: Vec<Channel>,
    /// One entry per layout slot: which channel id it holds (empty
    /// string = unassigned). Persisted in Config.layout_slots.
    slot_assignments: Vec<String>,
    /// Playing tiles, one per assigned slot. Sparse to allow gaps
    /// while a tile is being (re)spawned.
    tiles: Vec<Option<Tile>>,
    /// Current wall layout.
    layout: Layout,
    /// The parent wall window's client size in physical pixels.
    /// Used to translate relative slot rects → absolute pixel rects.
    parent_size: (u32, u32),
    /// Parent HWND — child tile windows inherit their z-order via
    /// `set_owner`.
    parent_hwnd: Option<isize>,
    /// Local NIC to bind IGMP joins to. Read from Config.
    localaddr: String,
}

impl Wall {
    pub fn new(cfg: &Config, channels: Vec<Channel>, parent_size: (u32, u32), parent_hwnd: Option<isize>) -> Self {
        let layout = layout_by_id(&cfg.layout);
        let stored = cfg.layout_slots.get(&layout.id.to_string()).cloned().unwrap_or_default();
        let mut slot_assignments: Vec<String> = stored.into_iter().collect();
        slot_assignments.resize(layout.slot_count(), String::new());
        let tiles: Vec<Option<Tile>> = (0..layout.slot_count()).map(|_| None).collect();
        Self {
            channels,
            slot_assignments,
            tiles,
            layout,
            parent_size,
            parent_hwnd,
            localaddr: cfg.multicast_localaddr.clone(),
        }
    }

    /// Switch to a different layout. Existing tiles are dropped (their
    /// pipelines stop cleanly via `Tile::drop`) and the new slot count
    /// takes effect. Assignments are looked up per-layout so the
    /// operator's Grid32 arrangement survives a temp switch to Mosaic.
    pub fn set_layout(&mut self, cfg: &Config, layout_id: &str) {
        self.tiles.clear();
        self.layout = layout_by_id(layout_id);
        let stored = cfg
            .layout_slots
            .get(&self.layout.id.to_string())
            .cloned()
            .unwrap_or_default();
        self.slot_assignments = stored.into_iter().collect();
        self.slot_assignments
            .resize(self.layout.slot_count(), String::new());
        self.tiles = (0..self.layout.slot_count()).map(|_| None).collect();
    }

    /// Fill any empty slot by cycling through the channel list —
    /// unassigned channels first (no duplicates until every channel
    /// is placed once), then duplicates. Matches Python's
    /// `Wall.enter_fullscreen` auto-fill behaviour so a wall PC with
    /// 30 channels + Grid32 (32 slots) never shows dead-black tiles.
    pub fn auto_fill_empty(&mut self, cfg: &Config) {
        if !cfg.auto_fill_empty_slots || self.channels.is_empty() {
            return;
        }
        let assigned: std::collections::HashSet<&str> = self
            .slot_assignments
            .iter()
            .filter(|s| !s.is_empty())
            .map(|s| s.as_str())
            .collect();
        let fresh: Vec<String> = self
            .channels
            .iter()
            .filter(|c| !assigned.contains(c.id.as_str()))
            .map(|c| c.id.clone())
            .collect();
        let dupes: Vec<String> = self.channels.iter().map(|c| c.id.clone()).collect();
        let pool: Vec<String> = fresh.into_iter().chain(dupes).collect();

        let mut k = 0usize;
        for slot in self.slot_assignments.iter_mut() {
            if slot.is_empty() {
                if pool.is_empty() {
                    break;
                }
                *slot = pool[k % pool.len()].clone();
                k += 1;
            }
        }
    }

    /// Spawn (or reposition) a tile for every currently-assigned slot.
    /// Idempotent — call after layout change, parent resize, or a
    /// channel-list refresh.
    pub fn realize(&mut self, event_loop: &ActiveEventLoop, cfg: &Config) -> Result<()> {
        let by_id: std::collections::HashMap<&str, &Channel> =
            self.channels.iter().map(|c| (c.id.as_str(), c)).collect();

        for (idx, slot) in self.layout.slots.clone().iter().enumerate() {
            let rect = slot_to_pixels(slot, self.parent_size);
            let ch_id = self.slot_assignments.get(idx).cloned().unwrap_or_default();
            let existing = self.tiles.get(idx).and_then(|o| o.as_ref()).map(|t| t.channel.id.clone());

            if ch_id.is_empty() {
                self.tiles[idx] = None;
                continue;
            }

            // Same channel already playing here → just reposition.
            if existing.as_deref() == Some(ch_id.as_str()) {
                if let Some(Some(t)) = self.tiles.get(idx) {
                    t.reposition(rect);
                }
                continue;
            }

            // Different (or absent) channel → drop old, spawn new.
            self.tiles[idx] = None;
            if let Some(ch) = by_id.get(ch_id.as_str()) {
                let fm = cfg.get_fill_mode(&ch.slug);
                match Tile::spawn(
                    event_loop,
                    self.parent_hwnd,
                    (*ch).clone(),
                    &self.localaddr,
                    rect,
                    fm,
                ) {
                    Ok(t) => self.tiles[idx] = Some(t),
                    Err(e) => log::error!(
                        "tile spawn slot {idx} for {}: {e:#}",
                        ch.slug
                    ),
                }
            }
        }
        Ok(())
    }

    /// Handle a parent-window resize — recompute each slot's absolute
    /// pixel rect and reposition every tile without recreating them.
    pub fn on_parent_resize(&mut self, new_size: (u32, u32)) {
        self.parent_size = new_size;
        for (idx, slot) in self.layout.slots.iter().enumerate() {
            if let Some(Some(t)) = self.tiles.get(idx) {
                t.reposition(slot_to_pixels(slot, new_size));
            }
        }
    }

    /// Assign a channel to a specific slot (operator picks from side
    /// panel and clicks a slot). Empty channel_id clears the slot.
    pub fn assign(&mut self, slot_idx: usize, channel_id: String) {
        if slot_idx < self.slot_assignments.len() {
            self.slot_assignments[slot_idx] = channel_id;
        }
    }

    /// Change fill mode for a specific channel — updates the running
    /// tile (if any) AND persists to cfg for future spawns.
    pub fn set_fill_mode(&mut self, cfg: &mut Config, slug: &str, mode: FillMode) {
        cfg.set_fill_mode(slug, mode);
        for tile in self.tiles.iter_mut().flatten() {
            if tile.channel.slug == slug {
                tile.set_fill_mode(mode);
            }
        }
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    pub fn slot_assignments(&self) -> &[String] {
        &self.slot_assignments
    }
}

fn slot_to_pixels(slot: &Slot, parent: (u32, u32)) -> (i32, i32, u32, u32) {
    let (pw, ph) = parent;
    let x = (slot.relx * pw as f32).round() as i32;
    let y = (slot.rely * ph as f32).round() as i32;
    let w = (slot.relwidth * pw as f32).round().max(1.0) as u32;
    let h = (slot.relheight * ph as f32).round().max(1.0) as u32;
    (x, y, w, h)
}

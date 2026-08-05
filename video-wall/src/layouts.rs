//! Wall layout definitions — mirror the Python `layouts.py` file
//! (single / dual / mosaic-20 / grid-32) so behaviour + tile counts
//! line up exactly with the existing viewer.
//!
//! A Slot is expressed in RELATIVE coordinates (0.0..=1.0) inside the
//! parent wall window, matching Tk's `relx`/`rely`/`relwidth`/`relheight`.
//! The wall renderer just multiplies these by the parent's pixel size
//! to compute each child window's rect.

#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub relx: f32,
    pub rely: f32,
    pub relwidth: f32,
    pub relheight: f32,
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub id: &'static str,
    pub label: &'static str,
    pub slots: Vec<Slot>,
}

impl Layout {
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

/// Physical wall geometry: 8 screens arranged 4 cols × 2 rows.
/// Each PHYSICAL screen occupies 0.25 × 0.5 of the total wall.
const COL_W: f32 = 0.25;
const ROW_H: f32 = 0.5;

/// LAYOUT_SINGLE — one tile fills the whole wall (fullscreen preview
/// of a single channel across all 8 physical screens).
pub fn layout_single() -> Layout {
    Layout {
        id: "single",
        label: "1 · Single",
        slots: vec![Slot { relx: 0.0, rely: 0.0, relwidth: 1.0, relheight: 1.0 }],
    }
}

/// LAYOUT_DUAL — two large tiles side by side (each half the wall).
pub fn layout_dual() -> Layout {
    Layout {
        id: "dual",
        label: "2 · Dual",
        slots: vec![
            Slot { relx: 0.0, rely: 0.0, relwidth: 0.5, relheight: 1.0 },
            Slot { relx: 0.5, rely: 0.0, relwidth: 0.5, relheight: 1.0 },
        ],
    }
}

/// LAYOUT_MOSAIC — top half of wall = 4 large tiles (one per physical
/// screen in the top row), bottom half = 16 quadrants (one physical
/// screen split 2×2). Total 20 non-overlapping slots covering the
/// whole wall exactly once — no more background streams leaking
/// through overlapped regions.
pub fn layout_mosaic() -> Layout {
    let mut slots: Vec<Slot> = Vec::with_capacity(20);
    // Top row: 4 big tiles, each one full physical screen (col 0..3, row 0).
    for col in 0..4 {
        slots.push(Slot {
            relx: col as f32 * COL_W,
            rely: 0.0,
            relwidth: COL_W,
            relheight: ROW_H,
        });
    }
    // Bottom row: 4 physical screens, each split into 4 quadrants
    // (2×2) → 16 tiles total.
    for col in 0..4 {
        for qy in 0..2 {
            for qx in 0..2 {
                slots.push(Slot {
                    relx: col as f32 * COL_W + qx as f32 * (COL_W / 2.0),
                    rely: ROW_H + qy as f32 * (ROW_H / 2.0),
                    relwidth: COL_W / 2.0,
                    relheight: ROW_H / 2.0,
                });
            }
        }
    }
    Layout { id: "mosaic", label: "3 · Mosaic (20)", slots }
}

/// LAYOUT_GRID32 — every physical screen split into 4 quadrants,
/// giving 8 screens × 4 = 32 uniform tiles. This is the busy view
/// for monitoring every channel at once.
pub fn layout_grid32() -> Layout {
    let mut slots = Vec::with_capacity(32);
    for row in 0..2 {
        for col in 0..4 {
            for qy in 0..2 {
                for qx in 0..2 {
                    slots.push(Slot {
                        relx: col as f32 * COL_W + qx as f32 * (COL_W / 2.0),
                        rely: row as f32 * ROW_H + qy as f32 * (ROW_H / 2.0),
                        relwidth: COL_W / 2.0,
                        relheight: ROW_H / 2.0,
                    });
                }
            }
        }
    }
    Layout { id: "grid32", label: "4 · Grid (32)", slots }
}

pub fn all() -> Vec<Layout> {
    vec![layout_single(), layout_dual(), layout_mosaic(), layout_grid32()]
}

pub fn by_id(id: &str) -> Layout {
    all().into_iter().find(|l| l.id == id).unwrap_or_else(layout_grid32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_counts_match_python_viewer() {
        assert_eq!(layout_single().slot_count(), 1);
        assert_eq!(layout_dual().slot_count(), 2);
        assert_eq!(layout_mosaic().slot_count(), 20);
        assert_eq!(layout_grid32().slot_count(), 32);
    }

    #[test]
    fn grid32_covers_full_wall_without_overlap() {
        let total: f32 = layout_grid32().slots.iter().map(|s| s.relwidth * s.relheight).sum();
        assert!((total - 1.0).abs() < 0.001, "grid32 area != 1.0 (got {total})");
    }
}

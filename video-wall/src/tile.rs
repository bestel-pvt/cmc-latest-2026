//! A single video-wall tile — one native child window whose HWND is
//! handed to a GStreamer d3d11videosink.
//!
//! Split out of `main.rs` so the wall manager can spawn / destroy
//! tiles as the layout changes without touching the event loop code.

use anyhow::{anyhow, Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_video::prelude::VideoOverlayExtManual;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::event_loop::ActiveEventLoop;
use winit::window::{Window, WindowAttributes};

use crate::api::Channel;
use crate::config::FillMode;
use crate::gst_pipeline;

/// One playing tile. Dropping the tile stops the pipeline + closes
/// the window automatically thanks to `Drop`.
pub struct Tile {
    pub window: Window,
    pub channel: Channel,
    pub fill_mode: FillMode,
    pipeline: gst::Pipeline,
}

impl Tile {
    /// Spawn a new child window and immediately start playing the
    /// channel's primary source through a d3d11 pipeline.
    pub fn spawn(
        event_loop: &ActiveEventLoop,
        parent_hwnd: Option<isize>,
        channel: Channel,
        localaddr: &str,
        rect_px: (i32, i32, u32, u32), // (x, y, w, h) inside parent
        fill_mode: FillMode,
    ) -> Result<Self> {
        // 1. Native window — bordered "child" of the wall parent so
        //    Windows composes them all into a single top-level frame.
        let (x, y, w, h) = rect_px;
        let mut attrs = WindowAttributes::default()
            .with_title(channel.name.clone())
            .with_decorations(false)
            .with_inner_size(winit::dpi::PhysicalSize::new(w.max(1), h.max(1)))
            .with_position(winit::dpi::PhysicalPosition::new(x, y));
        if let Some(hwnd) = parent_hwnd {
            use winit::platform::windows::WindowAttributesExtWindows;
            attrs = attrs.with_owner_window(hwnd);
        }
        let window = event_loop.create_window(attrs)?;

        // 2. Extract HWND from the winit window.
        let raw = window.window_handle()?.as_raw();
        let hwnd: usize = match raw {
            RawWindowHandle::Win32(h) => isize::from(h.hwnd) as usize,
            other => return Err(anyhow!("unexpected raw window handle: {other:?}")),
        };

        // 3. Build the pipeline. VLC-style URL is parsed into the
        //    address + port + multicast-iface fields that
        //    GStreamer's `udpsrc` expects.
        let url = channel
            .primary_url(localaddr)
            .ok_or_else(|| anyhow!("channel {} has no primary URL", channel.slug))?;
        let src = gst_pipeline::UdpSource::parse(&url)
            .with_context(|| format!("parse {url}"))?;
        let pipeline_str = gst_pipeline::udp_ts_d3d11(&src);

        let element = gst::parse::launch(&pipeline_str)
            .with_context(|| format!("parse pipeline: {pipeline_str}"))?;
        let pipeline: gst::Pipeline = element
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow!("expected a Pipeline"))?;

        // 4. Attach the videosink to this tile's HWND.
        let vsink = pipeline
            .by_name("vsink")
            .context("vsink not found in pipeline")?;
        let overlay = vsink
            .dynamic_cast::<gstreamer_video::VideoOverlay>()
            .map_err(|_| anyhow!("videosink is not a VideoOverlay"))?;
        // SAFETY: hwnd is from a window we just created and own; it
        // outlives the pipeline (pipeline is stopped in Drop before
        // the window drops).
        unsafe {
            overlay.set_window_handle(hwnd);
        }

        pipeline
            .set_state(gst::State::Playing)
            .context("Playing state")?;

        // 5. Apply the persisted fill mode.
        apply_fill_mode(&pipeline, fill_mode);

        Ok(Self { window, channel, fill_mode, pipeline })
    }

    /// Change fill mode at runtime — updates the aspect / crop
    /// negotiation without recreating the pipeline.
    pub fn set_fill_mode(&mut self, mode: FillMode) {
        self.fill_mode = mode;
        apply_fill_mode(&self.pipeline, mode);
    }

    /// Resize + reposition the tile in one call. Used when the parent
    /// wall resizes or the operator switches layouts.
    pub fn reposition(&self, rect_px: (i32, i32, u32, u32)) {
        let (x, y, w, h) = rect_px;
        self.window
            .set_outer_position(winit::dpi::PhysicalPosition::new(x, y));
        let _ = self
            .window
            .request_inner_size(winit::dpi::PhysicalSize::new(w.max(1), h.max(1)));
    }
}

impl Drop for Tile {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Push fill-mode overrides into the running pipeline. GStreamer's
/// `videoscale` element accepts `add-borders` (letterbox on/off) and
/// `videoconvert` handles aspect via caps filters — but the cleanest
/// per-tile control is via the sink's `force-aspect-ratio` property
/// (bool) on d3d11videosink + a caps event with the target dims.
///
/// For now:
///   stretch → force-aspect-ratio = false (fill regardless of source aspect)
///   fit     → force-aspect-ratio = true  (letterbox to preserve aspect)
///   crop    → force-aspect-ratio = false + upstream crop element added
///             (implemented in Phase 5 with dynamic pipeline mods)
fn apply_fill_mode(pipeline: &gst::Pipeline, mode: FillMode) {
    if let Some(vsink) = pipeline.by_name("vsink") {
        let force = matches!(mode, FillMode::Fit);
        vsink.set_property_from_str("force-aspect-ratio", &force.to_string());
    }
}

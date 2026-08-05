//! Fullscreen video-wall window — a separate borderless top-level
//! window that hosts N GStreamer pipelines, one per assigned slot.
//!
//! The eframe UI (config screen) stays running behind it; pressing
//! Esc or F11 closes this window and returns to config mode.
//!
//! We run winit's event loop for the wall INSIDE a dedicated thread
//! so it doesn't block eframe. Communication with the config UI is
//! via `WallCommand` on an mpsc channel.

use anyhow::{anyhow, Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_video::prelude::VideoOverlayExtManual;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::{Deserialize, Serialize};
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::window::{Fullscreen, Window, WindowAttributes, WindowId};

use crate::api::Channel;
use crate::config::{Config, FillMode};
use crate::gst_pipeline;
use crate::layouts::{by_id as layout_by_id, Slot};

/// Snapshot the UI hands to the wall process when Start Fullscreen
/// is clicked. Serialized to a temp JSON file and passed to the
/// child process via `--wall <path>`.
#[derive(Clone, Serialize, Deserialize)]
pub struct WallStart {
    pub layout_id: String,
    pub channels: Vec<Channel>,
    pub slot_assignments: Vec<String>,
    pub localaddr: String,
    pub fill_modes: std::collections::HashMap<String, FillMode>,
    pub auto_fill: bool,
}

impl WallStart {
    pub fn from_cfg(cfg: &Config, channels: Vec<Channel>) -> Self {
        let slots = cfg
            .layout_slots
            .get(&cfg.layout)
            .cloned()
            .unwrap_or_default();
        Self {
            layout_id: cfg.layout.clone(),
            channels,
            slot_assignments: slots,
            localaddr: cfg.multicast_localaddr.clone(),
            fill_modes: cfg.fill_modes.clone(),
            auto_fill: cfg.auto_fill_empty_slots,
        }
    }
}

/// Spawn the wall as a child process — re-invokes CMC-VideoWall.exe
/// with `--wall <tmp-json>`. Returns the Child handle so the UI can
/// send Ctrl+Break / Kill to close it, and know when the user quit
/// the wall (Esc/F11).
pub fn spawn_child(start: &WallStart) -> Result<std::process::Child> {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("cmc-wall-{}.json", std::process::id()));
    std::fs::write(&path, serde_json::to_vec(start)?)?;
    let exe = std::env::current_exe()?;
    let child = std::process::Command::new(exe)
        .arg("--wall")
        .arg(&path)
        .spawn()
        .context("spawn wall child process")?;
    Ok(child)
}

/// Called from `main` when this process was invoked with `--wall`.
/// Reads the JSON payload the UI wrote and runs the wall event loop
/// as the sole owner of the process's EventLoop — no eframe here.
pub fn run_from_json(json_path: &str) -> Result<()> {
    let raw = std::fs::read(json_path)
        .with_context(|| format!("read wall config {json_path}"))?;
    let start: WallStart = serde_json::from_slice(&raw)
        .with_context(|| format!("parse wall config {json_path}"))?;
    let _ = std::fs::remove_file(json_path); // one-shot

    let event_loop = winit::event_loop::EventLoop::new().context("winit event loop")?;
    event_loop.set_control_flow(ControlFlow::Wait);

    let mut app = WallApp {
        start,
        parent: None,
        tiles: Vec::new(),
        tiles_realized: false,
    };
    event_loop
        .run_app(&mut app)
        .map_err(|e| anyhow!("wall loop: {e}"))?;
    Ok(())
}

struct PlayingTile {
    /// Native Win32 child HWND — created via `CreateWindowExW` with
    /// `WS_CHILD`. NOT a winit window (winit can't do true child
    /// windows on Windows without decorations).
    hwnd: isize,
    pipeline: gst::Pipeline,
}

impl Drop for PlayingTile {
    fn drop(&mut self) {
        // Async pipeline shutdown — set_state(Null) can block for
        // hundreds of ms per pipeline while GStreamer flushes its
        // decoder threads. With 32 pipelines closed serially the
        // process appears frozen ("Not Responding") for ~10 s. We
        // pin the shutdown to a background thread so the drop
        // itself returns immediately.
        let pipeline = self.pipeline.clone();
        std::thread::spawn(move || {
            let _ = pipeline.set_state(gst::State::Null);
        });
        #[cfg(windows)]
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
            use windows::Win32::Foundation::HWND;
            let _ = DestroyWindow(HWND(self.hwnd as *mut _));
        }
    }
}

struct WallApp {
    start: WallStart,
    parent: Option<Window>,
    tiles: Vec<Option<PlayingTile>>,
    /// True once we've created tiles for the actual fullscreen
    /// size. Windows fullscreen transitions are async — the parent
    /// window's `inner_size()` in `resumed()` is the pre-fullscreen
    /// size, not what it becomes ~50 ms later. Creating tiles then
    /// pins their d3d11 swap chains to the wrong dimensions. We
    /// defer creation to the FIRST `Resized` event (which fires
    /// when fullscreen actually takes effect) so children hit the
    /// screen at the right size the first time.
    tiles_realized: bool,
}

impl ApplicationHandler for WallApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.parent.is_some() {
            return;
        }
        // Parent = borderless fullscreen window covering the whole
        // primary monitor. Child tiles are DEFERRED to the first
        // Resized event — see WallApp::tiles_realized comment.
        let attrs = WindowAttributes::default()
            .with_title("CMC Video Wall")
            .with_decorations(false)
            .with_fullscreen(Some(Fullscreen::Borderless(None)));
        let parent = match event_loop.create_window(attrs) {
            Ok(w) => w,
            Err(e) => {
                log::error!("create wall window: {e}");
                event_loop.exit();
                return;
            }
        };
        #[cfg(windows)]
        if let Some(h) = hwnd_of(&parent) {
            harden_parent(h);
        }
        self.parent = Some(parent);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::KeyboardInput { event: k, .. } => {
                use winit::keyboard::{Key, NamedKey};
                if matches!(k.logical_key, Key::Named(NamedKey::Escape) | Key::Named(NamedKey::F11)) {
                    // Fast-path exit — sequential pipeline teardown of
                    // 32 GStreamer pipelines takes ~10 s and hangs the
                    // window ("Not Responding"). We're the CHILD wall
                    // process, nothing to persist, so let the OS
                    // reclaim resources immediately.
                    std::process::exit(0);
                }
            }
            WindowEvent::Resized(_) => {
                // Use the parent HWND's ACTUAL client rect — the
                // coordinate space children are placed in. winit's
                // inner_size and the monitor size can both differ from
                // this due to borderless-fullscreen quirks and DPI
                // scaling. GetClientRect is what Win32 uses to lay
                // out child windows, so it's the ground truth for us.
                let true_size = self
                    .parent
                    .as_ref()
                    .and_then(hwnd_of)
                    .and_then(client_rect_size)
                    .unwrap_or_else(|| winit::dpi::PhysicalSize::new(1920, 1080));

                if !self.tiles_realized {
                    log::info!(
                        "realizing tiles at CLIENT RECT {}x{}",
                        true_size.width, true_size.height
                    );
                    self.realize_tiles(event_loop, true_size);
                    self.tiles_realized = true;
                } else {
                    let layout = layout_by_id(&self.start.layout_id);
                    for (idx, slot) in layout.slots.iter().enumerate() {
                        if let Some(Some(t)) = self.tiles.get(idx) {
                            #[cfg(windows)]
                            move_child_hwnd(t.hwnd, slot_pixels(slot, true_size));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn exiting(&mut self, _el: &ActiveEventLoop) {
        // Drop every tile in parallel — see PlayingTile::drop for the
        // background-thread trick. Then the process can exit even
        // while GStreamer threads are still winding down (they're
        // daemon-style, exit ends them). The parent window is
        // dropped after, which destroys any remaining child HWNDs
        // Windows-side.
        self.tiles.clear();
        self.parent = None;
    }
}

impl WallApp {
    /// Spawn all playing tiles now that we know the ACTUAL wall pixel
    /// dimensions. Called once from the first Resized event, not
    /// resumed(), because Windows fullscreen transitions are async
    /// and inner_size() lies at resume time.
    fn realize_tiles(&mut self, event_loop: &ActiveEventLoop, sz: winit::dpi::PhysicalSize<u32>) {
        let parent_hwnd = self.parent.as_ref().and_then(hwnd_of);
        let layout = layout_by_id(&self.start.layout_id);

        let mut assigns = self.start.slot_assignments.clone();
        assigns.resize(layout.slot_count(), String::new());
        if self.start.auto_fill && !self.start.channels.is_empty() {
            auto_fill(&mut assigns, &self.start.channels);
        }
        let by_id: std::collections::HashMap<&str, &Channel> =
            self.start.channels.iter().map(|c| (c.id.as_str(), c)).collect();

        // Layout-aware downsample threshold. Layouts with many tiles
        // hit CPU-decode limits at full source resolution; ones with
        // few tiles have headroom to render source-native.
        //   32-tile Grid → 240p. Tile is ~240×135 physical, so no
        //   extra info would survive a bigger decode anyway. Paired
        //   with a 15 fps rate cap in the pipeline this is what
        //   makes 32 concurrent decoders sustainable on a CPU-only
        //   host without the "atakne wala" jitter the operator
        //   described at higher tiers.
        //   20-tile Mosaic → 480p. 720p was crisp for the 4 big
        //   tiles but ~2× the pixels of what a mosaic tile needs
        //   and the extra scaling / decoding cost was showing up as
        //   stutter on the small quadrants. 480p keeps the big
        //   tiles readable (they upscale minimally to their ~960×540
        //   physical size) and roughly halves per-stream CPU.
        //   ≤ 2 tiles → full source resolution (no cap).
        let downsample_to: u32 = match layout.slot_count() {
            n if n >= 24 => 240,
            n if n >= 8 => 480,
            _ => 0,
        };

        self.tiles = Vec::with_capacity(layout.slot_count());
        for (idx, slot) in layout.slots.iter().enumerate() {
            let rect = slot_pixels(slot, sz);
            let ch_id = assigns.get(idx).cloned().unwrap_or_default();
            let ch = if ch_id.is_empty() {
                None
            } else {
                by_id.get(ch_id.as_str()).copied().cloned()
            };
            let tile = ch.and_then(|c| {
                let fm = self.start.fill_modes.get(&c.slug).copied().unwrap_or_default();
                let url = c
                    .primary_url(&self.start.localaddr)
                    .unwrap_or_else(|| "<no url>".to_string());
                match spawn_playing_tile(event_loop, parent_hwnd, c.clone(), &self.start.localaddr, rect, fm, downsample_to) {
                    Ok(t) => {
                        log::info!("slot {idx} {} → OK  url={url}", c.slug);
                        Some(t)
                    }
                    Err(e) => {
                        log::error!("slot {idx} {} FAILED url={url} err={e:#}", c.slug);
                        None
                    }
                }
            });
            self.tiles.push(tile);
        }
    }
}

fn spawn_playing_tile(
    _event_loop: &ActiveEventLoop,
    parent_hwnd: Option<isize>,
    channel: Channel,
    localaddr: &str,
    rect: (i32, i32, u32, u32),
    fill: FillMode,
    downsample_to: u32,
) -> Result<PlayingTile> {
    let parent = parent_hwnd.ok_or_else(|| anyhow!("no parent HWND"))?;
    let hwnd = create_child_hwnd(parent, rect)?;

    let url = channel
        .primary_url(localaddr)
        .ok_or_else(|| anyhow!("no primary URL for {}", channel.slug))?;
    let src = gst_pipeline::UdpSource::parse(&url)?;

    // Sink strategy — three-tier fallback so the wall works on any
    // Windows host, from GPU-equipped operator PCs down to headless
    // servers reached via RDP:
    //   1. glimagesink (shared GL context) — O(1) driver cost
    //      across N sinks; best for Grid32.
    //   2. d3d11videosink — fast on GPU hosts, caps at ~20 sinks.
    //   3. autovideosink — GStreamer picks whatever's actually
    //      registered (directdrawsink / d3dvideosink) so headless /
    //      RDP boxes without D3D11 or Mesa still render.
    // decodebin3 auto-picks the decoder for any codec (H.264, H.265,
    // MPEG-2).
    let pipeline = build_pipeline(
        &gst_pipeline::build_swdec_any_codec(&src, downsample_to, gst_pipeline::SinkKind::GlShared),
        hwnd,
    )
    .or_else(|_| {
        build_pipeline(
            &gst_pipeline::build_swdec_any_codec(&src, downsample_to, gst_pipeline::SinkKind::D3d11),
            hwnd,
        )
    })
    .or_else(|_| {
        build_pipeline(
            &gst_pipeline::build_swdec_any_codec(&src, downsample_to, gst_pipeline::SinkKind::Auto),
            hwnd,
        )
    })
    .with_context(|| format!("all sinks (GL + D3D11 + auto) failed for {}", channel.slug))?;

    if let Some(vsink) = pipeline.by_name("vsink") {
        apply_fill_mode(&vsink, fill);
    }
    Ok(PlayingTile { hwnd, pipeline })
}

/// Create a truly-borderless, no-decoration Win32 CHILD window using
/// `CreateWindowExW` with `WS_CHILD | WS_VISIBLE`. Uses our own
/// registered window class (`CMCTile`) with a BLACK background brush
/// — the default `STATIC` class ships with a white brush that
/// flashes through between GStreamer frames.
#[cfg(windows)]
fn create_child_hwnd(parent: isize, rect: (i32, i32, u32, u32)) -> Result<isize> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, HMENU, WINDOW_EX_STYLE, WS_CHILD, WS_VISIBLE, WS_CLIPCHILDREN,
        WS_CLIPSIBLINGS,
    };
    ensure_tile_class_registered()?;
    let (x, y, w_, h_) = rect;
    unsafe {
        let hinst = GetModuleHandleW(PCWSTR::null()).context("GetModuleHandle")?;
        let class_name: Vec<u16> = "CMCTile\0".encode_utf16().collect();
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            x, y, w_ as i32, h_ as i32,
            Some(HWND(parent as *mut _)),
            None as Option<HMENU>,
            Some(hinst.into()),
            None,
        )
        .context("CreateWindowExW child")?;
        Ok(hwnd.0 as isize)
    }
}

#[cfg(windows)]
fn ensure_tile_class_registered() -> Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, RegisterClassExW, HCURSOR, HICON, WNDCLASSEXW, WNDCLASS_STYLES,
        WNDPROC, CS_HREDRAW, CS_VREDRAW,
    };
    static REGISTERED: AtomicBool = AtomicBool::new(false);
    if REGISTERED.load(Ordering::Acquire) {
        return Ok(());
    }
    // Tile WndProc: intercept WM_ERASEBKGND to return "handled, no
    // paint" so Windows never draws the class background brush over
    // the tile between GStreamer frame presents. That intercept is
    // what stops the transient black flashes users saw during
    // decoder jitter — the last-presented video frame stays on
    // screen until d3d11videosink flips a new one in.
    use windows::Win32::UI::WindowsAndMessaging::WM_ERASEBKGND;
    unsafe extern "system" fn tile_wndproc(
        h: windows::Win32::Foundation::HWND,
        msg: u32,
        w: windows::Win32::Foundation::WPARAM,
        l: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        if msg == 0x0014 /* WM_ERASEBKGND */ {
            return windows::Win32::Foundation::LRESULT(1);
        }
        DefWindowProcW(h, msg, w, l)
    }
    let _ = WM_ERASEBKGND; // silence unused warning if compiler picks the const path
    unsafe {
        let hinst = GetModuleHandleW(PCWSTR::null()).context("GetModuleHandle")?;
        let class_name: Vec<u16> = "CMCTile\0".encode_utf16().collect();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            // CS_HREDRAW|CS_VREDRAW forces repaint on resize; needed
            // so GStreamer's overlay noticing the geometry change.
            style: WNDCLASS_STYLES(CS_HREDRAW.0 | CS_VREDRAW.0),
            lpfnWndProc: Some(tile_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst.into(),
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            // NULL brush — combined with the WM_ERASEBKGND intercept
            // in tile_wndproc, Windows never repaints the tile
            // background. Whatever d3d11videosink presented last
            // stays on screen until it presents again.
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            hIconSm: HICON::default(),
        };
        let atom = RegisterClassExW(&wc);
        if atom == 0 {
            anyhow::bail!("RegisterClassExW(CMCTile) failed");
        }
        REGISTERED.store(true, Ordering::Release);
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_child_hwnd(_parent: isize, _rect: (i32, i32, u32, u32)) -> Result<isize> {
    anyhow::bail!("child windows only supported on Windows for now")
}

/// Add `WS_CLIPCHILDREN` to the parent, subclass its WndProc to
/// intercept `WM_ERASEBKGND` (so it never repaints its own background
/// over the child tiles), and set the class background brush to black
/// as belt-and-braces for the first paint before subclassing kicks in.
#[cfg(windows)]
fn harden_parent(hwnd: isize) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateSolidBrush, InvalidateRect};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, GetWindowLongPtrW, SetClassLongPtrW, SetWindowLongPtrW,
        GCLP_HBRBACKGROUND, GWLP_WNDPROC, GWL_STYLE, WM_ERASEBKGND, WM_PAINT,
        WNDPROC, WS_CLIPCHILDREN,
    };
    use std::sync::atomic::{AtomicIsize, Ordering};

    // Storage for the original WndProc pointer so we can chain to it.
    static ORIG_WNDPROC: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn parent_wndproc(
        h: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> LRESULT {
        // Swallow background-erase entirely — return 1 = "erased".
        // Same for stray WM_PAINT: reply with a no-op so the parent
        // never paints its own client area on top of the tiles.
        if msg == WM_ERASEBKGND {
            return LRESULT(1);
        }
        let orig = ORIG_WNDPROC.load(Ordering::Acquire);
        let orig_fn: WNDPROC = std::mem::transmute(orig);
        match orig_fn {
            Some(f) => CallWindowProcW(Some(f), h, msg, w, l),
            None => windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(h, msg, w, l),
        }
    }

    unsafe {
        let h = HWND(hwnd as *mut _);
        let style = GetWindowLongPtrW(h, GWL_STYLE) as u32;
        SetWindowLongPtrW(h, GWL_STYLE, (style | WS_CLIPCHILDREN.0) as isize);

        let black = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0));
        SetClassLongPtrW(h, GCLP_HBRBACKGROUND, black.0 as isize);

        // Install our WndProc; save the previous one for chaining.
        let prev = SetWindowLongPtrW(h, GWLP_WNDPROC, parent_wndproc as usize as isize);
        ORIG_WNDPROC.store(prev, Ordering::Release);

        let _ = InvalidateRect(Some(h), None, true);
        let _ = WM_PAINT; // suppress unused import warning
    }
}

/// Ask Win32 for the parent HWND's client rect — the pixel space
/// child windows are laid out inside. Independent of winit and any
/// borderless-fullscreen weirdness.
#[cfg(windows)]
fn client_rect_size(hwnd: isize) -> Option<winit::dpi::PhysicalSize<u32>> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
    unsafe {
        let mut r = RECT::default();
        if GetClientRect(HWND(hwnd as *mut _), &mut r).is_ok() {
            let w = (r.right - r.left).max(1) as u32;
            let h = (r.bottom - r.top).max(1) as u32;
            Some(winit::dpi::PhysicalSize::new(w, h))
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn move_child_hwnd(hwnd: isize, rect: (i32, i32, u32, u32)) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOZORDER,
    };
    let (x, y, w_, h_) = rect;
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd as *mut _),
            Some(HWND_TOP),
            x, y, w_ as i32, h_ as i32,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

fn build_pipeline(pipeline_str: &str, hwnd: isize) -> Result<gst::Pipeline> {
    let element = gst::parse::launch(pipeline_str)
        .with_context(|| format!("parse pipeline: {pipeline_str}"))?;
    let pipeline: gst::Pipeline = element
        .downcast::<gst::Pipeline>()
        .map_err(|_| anyhow!("expected Pipeline"))?;
    let vsink = pipeline.by_name("vsink").context("vsink missing")?;
    if let Ok(overlay) = vsink.dynamic_cast::<gstreamer_video::VideoOverlay>() {
        unsafe { overlay.set_window_handle(hwnd as usize); }
    }
    pipeline
        .set_state(gst::State::Playing)
        .with_context(|| "set to Playing".to_string())?;
    Ok(pipeline)
}

fn apply_fill_mode(vsink: &gst::Element, mode: FillMode) {
    // d3d11videosink respects `force-aspect-ratio` (bool).
    //   Stretch → false (fill the tile, ignore source aspect)
    //   Fit     → true  (preserve source aspect, letterbox)
    //   Crop    → false + upstream crop element (Phase 5.5)
    let force_ratio = matches!(mode, FillMode::Fit);
    vsink.set_property_from_str("force-aspect-ratio", &force_ratio.to_string());
}

fn hwnd_of(w: &Window) -> Option<isize> {
    let raw = w.window_handle().ok()?.as_raw();
    if let RawWindowHandle::Win32(h) = raw {
        Some(isize::from(h.hwnd))
    } else {
        None
    }
}

fn slot_pixels(slot: &Slot, parent: winit::dpi::PhysicalSize<u32>) -> (i32, i32, u32, u32) {
    let (pw, ph) = (parent.width as f32, parent.height as f32);
    let x = (slot.relx * pw).round() as i32;
    let y = (slot.rely * ph).round() as i32;
    let w = (slot.relwidth * pw).round().max(1.0) as u32;
    let h = (slot.relheight * ph).round().max(1.0) as u32;
    (x, y, w, h)
}

fn auto_fill(assigns: &mut [String], channels: &[Channel]) {
    let taken: std::collections::HashSet<&str> =
        assigns.iter().filter(|s| !s.is_empty()).map(|s| s.as_str()).collect();
    let fresh: Vec<String> = channels
        .iter()
        .filter(|c| !taken.contains(c.id.as_str()))
        .map(|c| c.id.clone())
        .collect();
    let dupes: Vec<String> = channels.iter().map(|c| c.id.clone()).collect();
    let pool: Vec<String> = fresh.into_iter().chain(dupes).collect();
    let mut k = 0usize;
    for slot in assigns.iter_mut() {
        if slot.is_empty() {
            if pool.is_empty() {
                break;
            }
            *slot = pool[k % pool.len()].clone();
            k += 1;
        }
    }
}


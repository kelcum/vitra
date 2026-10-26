use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::util;

const SEGMENT_MS: i64 = 2_000;
const FPS: u32 = 30;

#[derive(Debug, Clone, Copy)]
pub struct ClipSettings {
    pub max_height: u32,
    pub bitrate: u32,
    pub before_ms: i64,
    pub after_ms: i64,
}

impl ClipSettings {
    pub fn from(settings: &crate::settings::Settings) -> Self {
        let (before, after) = match settings.clip_seconds {
            0..=10 => (7, 3),
            11..=20 => (15, 5),
            _ => (20, 10),
        };
        let (max_height, bitrate) = if settings.clip_quality == "1080p" { (1080, 10_000_000) } else { (720, 6_000_000) };
        Self { max_height, bitrate, before_ms: before * 1000, after_ms: after * 1000 }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Segment {
    path: PathBuf,
    start: i64,
    end: i64,
    width: u32,
    height: u32,
}

struct Shared {
    dir: PathBuf,
    settings: ClipSettings,
    segments: Mutex<VecDeque<Segment>>,
    stopped: AtomicBool,
}

impl Shared {
    fn keep_ms(&self) -> i64 {
        self.settings.before_ms + self.settings.after_ms + 3 * SEGMENT_MS
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn add(&self, segment: Segment) {
        let mut segments = self.segments.lock().unwrap_or_else(|e| e.into_inner());
        segments.push_back(segment);
        let oldest = util::now_millis() - self.keep_ms();
        while segments.front().is_some_and(|s| s.end < oldest) {
            if let Some(old) = segments.pop_front() {
                let _ = std::fs::remove_file(old.path);
            }
        }
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub struct Recorder {
    shared: Arc<Shared>,
}

impl Recorder {
    pub fn start(pid: u32, dir: PathBuf, settings: ClipSettings) -> Option<Self> {
        if !cfg!(windows) {
            return None;
        }
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        let shared = Arc::new(Shared { dir, settings, segments: Mutex::new(VecDeque::new()), stopped: AtomicBool::new(false) });
        #[cfg(windows)]
        {
            let s = shared.clone();
            std::thread::Builder::new().name("Vitra clips".into()).spawn(move || imp::record(pid, &s)).ok()?;
        }
        #[cfg(not(windows))]
        let _ = pid;
        Some(Self { shared })
    }

    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
    }

    pub fn save(&self, at: i64, out: &Path) -> bool {
        let s = &self.shared;
        let (from, to) = (at - s.settings.before_ms, at + s.settings.after_ms);
        let deadline = util::now_millis() + s.settings.after_ms + 3 * SEGMENT_MS + 5_000;
        loop {
            let covered = s.segments.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|seg| seg.end >= to);
            if covered || s.stopped.load(Ordering::SeqCst) || util::now_millis() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let chosen = pick(&s.segments.lock().unwrap_or_else(|e| e.into_inner()), from, to, at);
        if chosen.is_empty() {
            return false;
        }
        #[cfg(windows)]
        {
            match imp::join(&chosen, to, out) {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("Couldn't save a clip: {e}");
                    let _ = std::fs::remove_file(out);
                    false
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = out;
            false
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.stop();
    }
}

fn pick(segments: &VecDeque<Segment>, from: i64, to: i64, at: i64) -> Vec<Segment> {
    let around: Vec<&Segment> = segments.iter().filter(|s| s.end > from && s.start < to).collect();
    let Some(anchor) = around.iter().rev().find(|s| s.start <= at).or(around.first()) else { return vec![] };
    let size = (anchor.width, anchor.height);
    let mut out: Vec<Segment> = Vec::new();
    let reaches = |run: &Vec<Segment>| run.last().is_some_and(|last| last.end > at);
    for s in around {
        let gap = out.last().is_some_and(|last| s.start - last.end > SEGMENT_MS);
        if (s.width, s.height) != size || gap {
            if reaches(&out) {
                break;
            }
            out.clear();
        }
        if (s.width, s.height) == size {
            out.push(s.clone());
        }
    }
    out
}

pub fn output_size(width: u32, height: u32, max_height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let h = height.min(max_height);
    let w = ((width as u64 * h as u64) / height as u64) as u32;
    let even = |v: u32| (v & !1).max(2);
    (even(w.min(3840)), even(h))
}

#[cfg(windows)]
mod imp {
    use std::mem::ManuallyDrop;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use windows::core::{HSTRING, Interface, Result};
    use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Win32::Foundation::{HMODULE, HWND, RECT};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow};

    use super::{FPS, SEGMENT_MS, Segment, Shared, output_size};
    use crate::capture::imp::{client_area, find_window};
    use crate::util;

    struct MediaFoundation;

    impl MediaFoundation {
        fn start() -> Result<Self> {
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
            Ok(Self)
        }
    }

    impl Drop for MediaFoundation {
        fn drop(&mut self) {
            let _ = unsafe { MFShutdown() };
        }
    }

    pub fn record(pid: u32, shared: &Shared) {
        let Ok(_mf) = MediaFoundation::start() else { return };
        let mut counter = 0u32;
        while !shared.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            let Some(hwnd) = find_window(pid) else {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            };
            if unsafe { IsIconic(hwnd) }.as_bool() {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            if let Err(e) = Session::new(hwnd, shared).and_then(|mut s| s.run(&mut counter)) {
                log::warn!("Clip recording paused: {e}");
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }

    fn writer_attributes() -> Result<IMFAttributes> {
        let mut attributes = None;
        unsafe { MFCreateAttributes(&mut attributes, 3)? };
        let attributes = attributes.ok_or_else(windows::core::Error::empty)?;
        unsafe {
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
            attributes.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
        }
        Ok(attributes)
    }

    fn video_type(subtype: &windows::core::GUID, width: u32, height: u32) -> Result<IMFMediaType> {
        let t = unsafe { MFCreateMediaType()? };
        unsafe {
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
            t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)?;
            t.SetUINT64(&MF_MT_FRAME_RATE, ((FPS as u64) << 32) | 1)?;
            t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        }
        Ok(t)
    }

    struct Writer {
        sink: IMFSinkWriter,
        stream: u32,
        segment: Segment,
    }

    impl Writer {
        fn open(path: &Path, width: u32, height: u32, bitrate: u32, start: i64) -> Result<Self> {
            let sink = unsafe { MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &writer_attributes()?)? };
            let output = video_type(&MFVideoFormat_H264, width, height)?;
            unsafe {
                output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32)?;
            }
            let stream = unsafe { sink.AddStream(&output)? };
            let input = video_type(&MFVideoFormat_NV12, width, height)?;
            unsafe {
                input.SetUINT32(&MF_MT_DEFAULT_STRIDE, width)?;
                sink.SetInputMediaType(stream, &input, None)?;
                sink.BeginWriting()?;
            }
            let segment = Segment { path: path.to_path_buf(), start, end: start, width, height };
            Ok(Self { sink, stream, segment })
        }

        fn write(&mut self, nv12: &[u8], at: i64) -> Result<()> {
            let buffer = unsafe { MFCreateMemoryBuffer(nv12.len() as u32)? };
            unsafe {
                let mut data = std::ptr::null_mut();
                buffer.Lock(&mut data, None, None)?;
                std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, nv12.len());
                buffer.Unlock()?;
                buffer.SetCurrentLength(nv12.len() as u32)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buffer)?;
                sample.SetSampleTime((at - self.segment.start) * 10_000)?;
                sample.SetSampleDuration(10_000_000 / FPS as i64)?;
                self.sink.WriteSample(self.stream, &sample)?;
            }
            self.segment.end = at + 1000 / FPS as i64;
            Ok(())
        }

        fn finish(self) -> Option<Segment> {
            match unsafe { self.sink.Finalize() } {
                Ok(()) => Some(self.segment),
                Err(e) => {
                    log::warn!("Couldn't finish a clip segment: {e}");
                    let _ = std::fs::remove_file(&self.segment.path);
                    None
                }
            }
        }
    }

    struct Session<'a> {
        shared: &'a Shared,
        hwnd: HWND,
        context: ID3D11DeviceContext,
        video: ID3D11VideoContext,
        processor: ID3D11VideoProcessor,
        input: ID3D11Texture2D,
        input_view: ID3D11VideoProcessorInputView,
        output: ID3D11Texture2D,
        output_view: ID3D11VideoProcessorOutputView,
        staging: [ID3D11Texture2D; 2],
        pool: Direct3D11CaptureFramePool,
        capture: windows::Graphics::Capture::GraphicsCaptureSession,
        size: windows::Graphics::SizeInt32,
        width: u32,
        height: u32,
    }

    impl Drop for Session<'_> {
        fn drop(&mut self) {
            let _ = self.capture.Close();
            let _ = self.pool.Close();
        }
    }

    fn texture(device: &ID3D11Device, desc: &D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D> {
        let mut t = None;
        unsafe { device.CreateTexture2D(desc, None, Some(&mut t))? };
        t.ok_or_else(windows::core::Error::empty)
    }

    impl<'a> Session<'a> {
        fn new(hwnd: HWND, shared: &'a Shared) -> Result<Self> {
            let mut device: Option<ID3D11Device> = None;
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                )?
            };
            let device = device.ok_or_else(windows::core::Error::empty)?;
            let context = unsafe { device.GetImmediateContext()? };
            let video_device: ID3D11VideoDevice = device.cast()?;
            let video: ID3D11VideoContext = context.cast()?;
            let dxgi: IDXGIDevice = device.cast()?;
            let d3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;

            let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
            let size = item.Size()?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
            let capture = pool.CreateCaptureSession(&item)?;
            let _ = capture.SetIsCursorCaptureEnabled(false);
            let _ = capture.SetIsBorderRequired(false);

            let (sw, sh) = (size.Width.max(1) as u32, size.Height.max(1) as u32);
            let (cx, cy, cw, ch) = client_area(hwnd, sw, sh);
            let (width, height) = output_size(cw, ch, shared.settings.max_height);

            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
                InputWidth: sw,
                InputHeight: sh,
                OutputFrameRate: DXGI_RATIONAL { Numerator: FPS, Denominator: 1 },
                OutputWidth: width,
                OutputHeight: height,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&content)? };
            let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0)? };

            let base = D3D11_TEXTURE2D_DESC {
                Width: sw,
                Height: sh,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let input = texture(&device, &base)?;
            let nv12 = D3D11_TEXTURE2D_DESC { Width: width, Height: height, Format: DXGI_FORMAT_NV12, BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32, ..base };
            let output = texture(&device, &nv12)?;
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..nv12
            };
            let staging = [texture(&device, &staging_desc)?, texture(&device, &staging_desc)?];

            let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input_view = None;
            unsafe { video_device.CreateVideoProcessorInputView(&input, &enumerator, &input_desc, Some(&mut input_view))? };
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut output_view = None;
            unsafe { video_device.CreateVideoProcessorOutputView(&output, &enumerator, &output_desc, Some(&mut output_view))? };

            let source = RECT { left: cx as i32, top: cy as i32, right: (cx + cw) as i32, bottom: (cy + ch) as i32 };
            let target = RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 };
            unsafe {
                video.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
                video.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&source));
                video.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&target));
                video.VideoProcessorSetOutputTargetRect(&processor, true, Some(&target));
            }
            capture.StartCapture()?;
            Ok(Self {
                shared,
                hwnd,
                context,
                video,
                processor,
                input,
                input_view: input_view.ok_or_else(windows::core::Error::empty)?,
                output,
                output_view: output_view.ok_or_else(windows::core::Error::empty)?,
                staging,
                pool,
                capture,
                size,
                width,
                height,
            })
        }

        fn convert(&self, staging: usize) -> Result<()> {
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(Some(self.input_view.clone())),
                ..Default::default()
            };
            let mut streams = [stream];
            let result = unsafe { self.video.VideoProcessorBlt(&self.processor, &self.output_view, 0, &streams) };
            unsafe { ManuallyDrop::drop(&mut streams[0].pInputSurface) };
            result?;
            unsafe { self.context.CopyResource(&self.staging[staging], &self.output) };
            Ok(())
        }

        fn read(&self, staging: usize, out: &mut Vec<u8>) -> Result<()> {
            let (w, h) = (self.width as usize, self.height as usize);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe { self.context.Map(&self.staging[staging], 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
            out.clear();
            let pitch = mapped.RowPitch as usize;
            let base = mapped.pData as *const u8;
            for row in 0..h + h / 2 {
                let line = unsafe { std::slice::from_raw_parts(base.add(row * pitch), w) };
                out.extend_from_slice(line);
            }
            unsafe { self.context.Unmap(&self.staging[staging], 0) };
            Ok(())
        }

        fn run(&mut self, counter: &mut u32) -> Result<()> {
            let interval = 1000 / FPS as i64;
            let mut writer: Option<Writer> = None;
            let mut pending: Option<(usize, i64)> = None;
            let mut next = 0usize;
            let mut last = 0i64;
            let mut checked = Instant::now();
            let mut nv12 = Vec::with_capacity((self.width * self.height * 3 / 2) as usize);
            let result = loop {
                if self.shared.stopped.load(std::sync::atomic::Ordering::SeqCst) {
                    break Ok(());
                }
                if checked.elapsed() > Duration::from_millis(500) {
                    checked = Instant::now();
                    if !unsafe { IsWindow(Some(self.hwnd)) }.as_bool() || unsafe { IsIconic(self.hwnd) }.as_bool() {
                        break Ok(());
                    }
                }
                let Ok(frame) = self.pool.TryGetNextFrame() else {
                    std::thread::sleep(Duration::from_millis(4));
                    continue;
                };
                if frame.ContentSize()? != self.size {
                    break Ok(());
                }
                let now = util::now_millis();
                if now - last < interval - 2 {
                    continue;
                }
                last = now;
                let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
                let source: ID3D11Texture2D = unsafe { access.GetInterface()? };
                unsafe { self.context.CopyResource(&self.input, &source) };
                drop(frame);
                if let Err(e) = self.convert(next) {
                    break Err(e);
                }
                if let Some((index, at)) = pending.take() {
                    if let Err(e) = self.read(index, &mut nv12) {
                        break Err(e);
                    }
                    if writer.as_ref().is_some_and(|w| at - w.segment.start >= SEGMENT_MS)
                        && let Some(done) = writer.take().and_then(Writer::finish)
                    {
                        self.shared.add(done);
                    }
                    if writer.is_none() {
                        *counter += 1;
                        let path = self.shared.dir.join(format!("segment-{counter}.mp4"));
                        match Writer::open(&path, self.width, self.height, self.shared.settings.bitrate, at) {
                            Ok(w) => writer = Some(w),
                            Err(e) => break Err(e),
                        }
                    }
                    if let Some(w) = writer.as_mut()
                        && let Err(e) = w.write(&nv12, at)
                    {
                        break Err(e);
                    }
                }
                pending = Some((next, now));
                next ^= 1;
            };
            if let Some(done) = writer.and_then(Writer::finish) {
                self.shared.add(done);
            }
            result
        }
    }

    pub fn join(segments: &[Segment], to: i64, out: &Path) -> Result<()> {
        let first_segment = segments.first().ok_or_else(windows::core::Error::empty)?;
        let _mf = MediaFoundation::start()?;
        let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let first = unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(first_segment.path.as_os_str()), None)? };
        let format = unsafe { first.GetNativeMediaType(stream_index, 0)? };
        let sink = unsafe { MFCreateSinkWriterFromURL(&HSTRING::from(out.as_os_str()), None, &writer_attributes()?)? };
        let stream = unsafe { sink.AddStream(&format)? };
        unsafe {
            sink.SetInputMediaType(stream, &format, None)?;
            sink.BeginWriting()?;
        }
        drop(first);
        let base = first_segment.start * 10_000;
        let mut last = -1i64;
        'segments: for segment in segments {
            let reader = unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(segment.path.as_os_str()), None)? };
            loop {
                let mut flags = 0u32;
                let mut time = 0i64;
                let mut sample = None;
                unsafe { reader.ReadSample(stream_index, 0, None, Some(&mut flags), Some(&mut time), Some(&mut sample))? };
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    break;
                }
                let Some(sample) = sample else { continue };
                let absolute = segment.start * 10_000 + time;
                if absolute > to * 10_000 {
                    break 'segments;
                }
                let at = (absolute - base).max(last + 1);
                last = at;
                unsafe {
                    sample.SetSampleTime(at)?;
                    sink.WriteSample(stream, &sample)?;
                }
            }
        }
        if last < 0 {
            return Err(windows::core::Error::empty());
        }
        unsafe { sink.Finalize() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: i64, end: i64, size: (u32, u32)) -> Segment {
        Segment { path: PathBuf::from(format!("{start}.mp4")), start, end, width: size.0, height: size.1 }
    }

    #[test]
    fn picks_the_segments_around_a_moment() {
        let hd = (1280, 720);
        let all: VecDeque<Segment> = [seg(0, 2000, hd), seg(2000, 4000, hd), seg(4000, 6000, hd), seg(6000, 8000, hd), seg(8000, 10000, hd)].into();
        let starts = |v: Vec<Segment>| v.iter().map(|s| s.start).collect::<Vec<_>>();
        assert_eq!(starts(pick(&all, 3000, 7000, 5000)), vec![2000, 4000, 6000]);
        assert_eq!(starts(pick(&all, -5000, 1000, 500)), vec![0]);
        assert!(pick(&all, 20000, 30000, 25000).is_empty());

        let resized: VecDeque<Segment> = [seg(0, 2000, hd), seg(2000, 4000, (1920, 1080)), seg(4000, 6000, (1920, 1080))].into();
        assert_eq!(starts(pick(&resized, 0, 6000, 3000)), vec![2000, 4000]);
        let gap: VecDeque<Segment> = [seg(0, 2000, hd), seg(9000, 11000, hd), seg(11000, 13000, hd)].into();
        assert_eq!(starts(pick(&gap, 0, 13000, 10000)), vec![9000, 11000]);
    }

    #[test]
    fn output_sizes_are_even_and_capped() {
        assert_eq!(output_size(2560, 1440, 720), (1280, 720));
        assert_eq!(output_size(854, 480, 720), (854, 480));
        assert_eq!(output_size(1921, 1081, 1080), (1918, 1080));
        assert_eq!(output_size(3440, 1440, 1080), (2580, 1080));
        assert_eq!(output_size(0, 0, 720), (0, 0));
    }
}

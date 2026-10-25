pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

pub fn window_of_process(pid: u32) -> Option<Frame> {
    #[cfg(windows)]
    {
        imp::capture(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

pub fn shrink(frame: &Frame, max_side: u32) -> Frame {
    let (w, h) = (frame.width, frame.height);
    let longest = w.max(h);
    if longest <= max_side || w == 0 || h == 0 {
        return Frame { width: w, height: h, bgra: frame.bgra.clone() };
    }
    let nw = ((w as u64 * max_side as u64) / longest as u64).max(1) as u32;
    let nh = ((h as u64 * max_side as u64) / longest as u64).max(1) as u32;
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        let y0 = (y as u64 * h as u64 / nh as u64) as u32;
        let y1 = (((y + 1) as u64 * h as u64 / nh as u64) as u32).max(y0 + 1).min(h);
        for x in 0..nw {
            let x0 = (x as u64 * w as u64 / nw as u64) as u32;
            let x1 = (((x + 1) as u64 * w as u64 / nw as u64) as u32).max(x0 + 1).min(w);
            let mut sum = [0u32; 4];
            for sy in y0..y1 {
                let row = (sy * w) as usize * 4;
                for sx in x0..x1 {
                    let i = row + sx as usize * 4;
                    for (total, &v) in sum.iter_mut().zip(&frame.bgra[i..i + 4]) {
                        *total += v as u32;
                    }
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            let o = ((y * nw + x) * 4) as usize;
            for (px, total) in out[o..o + 4].iter_mut().zip(sum) {
                *px = (total / n) as u8;
            }
        }
    }
    Frame { width: nw, height: nh, bgra: out }
}

pub fn jpeg(frame: &Frame, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let encoder = jpeg_encoder::Encoder::new(&mut out, quality);
    encoder
        .encode(&frame.bgra, u16::try_from(frame.width).ok()?, u16::try_from(frame.height).ok()?, jpeg_encoder::ColorType::Bgra)
        .ok()?;
    Some(out)
}

#[cfg(windows)]
pub(crate) mod imp {
    use std::time::{Duration, Instant};

    use windows::core::{BOOL, Interface};
    use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetClientRect, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };

    use super::Frame;

    const FRAME_WAIT: Duration = Duration::from_millis(1500);

    struct Search {
        pid: u32,
        best: Option<HWND>,
        area: i64,
    }

    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let search = unsafe { &mut *(data.0 as *mut Search) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|o| !o.is_invalid());
        if pid == search.pid && unsafe { IsWindowVisible(hwnd) }.as_bool() && !owned {
            let mut r = RECT::default();
            if unsafe { GetClientRect(hwnd, &mut r) }.is_ok() {
                let area = (r.right - r.left) as i64 * (r.bottom - r.top) as i64;
                if area > search.area {
                    search.area = area;
                    search.best = Some(hwnd);
                }
            }
        }
        true.into()
    }

    pub(crate) fn find_window(pid: u32) -> Option<HWND> {
        let mut search = Search { pid, best: None, area: 0 };
        let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize)) };
        search.best
    }

    pub fn capture(pid: u32) -> Option<Frame> {
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        let hwnd = find_window(pid)?;
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return None;
        }
        match grab(hwnd) {
            Ok(frame) => frame,
            Err(e) => {
                log::warn!("Couldn't capture the game window: {e}");
                None
            }
        }
    }

    pub(crate) fn client_area(hwnd: HWND, width: u32, height: u32) -> (u32, u32, u32, u32) {
        let mut frame = RECT::default();
        let mut client = RECT::default();
        let mut origin = POINT::default();
        let ok = unsafe {
            DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut RECT as *mut _, size_of::<RECT>() as u32).is_ok()
                && GetClientRect(hwnd, &mut client).is_ok()
                && ClientToScreen(hwnd, &mut origin).as_bool()
        };
        if !ok {
            return (0, 0, width, height);
        }
        let x = (origin.x - frame.left).clamp(0, width as i32) as u32;
        let y = (origin.y - frame.top).clamp(0, height as i32) as u32;
        let w = (client.right - client.left).max(0) as u32;
        let h = (client.bottom - client.top).max(0) as u32;
        let w = w.min(width - x);
        let h = h.min(height - y);
        if w == 0 || h == 0 { (0, 0, width, height) } else { (x, y, w, h) }
    }

    fn grab(hwnd: HWND) -> windows::core::Result<Option<Frame>> {
        let mut device: Option<ID3D11Device> = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )?
        };
        let Some(device) = device else { return Ok(None) };
        let context = unsafe { device.GetImmediateContext()? };
        let dxgi: IDXGIDevice = device.cast()?;
        let d3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;

        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, item.Size()?)?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsCursorCaptureEnabled(false);
        let _ = session.SetIsBorderRequired(false);
        session.StartCapture()?;

        let started = Instant::now();
        let frame = loop {
            if let Ok(frame) = pool.TryGetNextFrame() {
                break Some(frame);
            }
            if started.elapsed() > FRAME_WAIT {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let result = match frame {
            None => None,
            Some(frame) => {
                let size = frame.ContentSize()?;
                let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
                let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe { texture.GetDesc(&mut desc) };
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.MiscFlags = 0;
                let mut staging: Option<ID3D11Texture2D> = None;
                unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging))? };
                let Some(staging) = staging else { return Ok(None) };
                unsafe { context.CopyResource(&staging, &texture) };

                let width = (size.Width.max(0) as u32).min(desc.Width);
                let height = (size.Height.max(0) as u32).min(desc.Height);
                let (cx, cy, cw, ch) = client_area(hwnd, width, height);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))? };
                let mut bgra = Vec::with_capacity((cw * ch * 4) as usize);
                for row in cy..cy + ch {
                    let line = unsafe {
                        std::slice::from_raw_parts((mapped.pData as *const u8).add(row as usize * mapped.RowPitch as usize + cx as usize * 4), cw as usize * 4)
                    };
                    bgra.extend_from_slice(line);
                }
                unsafe { context.Unmap(&staging, 0) };
                for alpha in bgra.iter_mut().skip(3).step_by(4) {
                    *alpha = 255;
                }
                Some(Frame { width: cw, height: ch, bgra })
            }
        };
        let _ = session.Close();
        let _ = pool.Close();
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shrinks_and_encodes() {
        let mut bgra = Vec::new();
        for _ in 0..2 {
            for x in 0..4 {
                let v = if x < 2 { 255 } else { 0 };
                bgra.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let frame = Frame { width: 4, height: 2, bgra };
        let small = shrink(&frame, 2);
        assert_eq!((small.width, small.height), (2, 1));
        assert_eq!(&small.bgra[..4], &[255, 255, 255, 255]);
        assert_eq!(&small.bgra[4..], &[0, 0, 0, 255]);
        assert_eq!(shrink(&frame, 10).width, 4);
        let jpg = jpeg(&frame, 85).unwrap();
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
    }
}

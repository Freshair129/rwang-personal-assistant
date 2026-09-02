use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // tauri-build requires an ICO while compiling the Windows resource file.
    // Keep the scaffold buildable before the branding asset is supplied by the
    // release pipeline; the generated fallback lives under OUT_DIR only.
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let fallback_icon = out_dir.join("rwang-fallback.ico");
    if !fallback_icon.exists() {
        fs::write(&fallback_icon, fallback_ico()).expect("write fallback Windows icon");
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_icon = manifest_dir.join("icons/icon.png");
    if !source_icon.exists() {
        fs::create_dir_all(source_icon.parent().expect("icon parent"))
            .expect("create source icon directory");
        fs::write(source_icon, fallback_png()).expect("write fallback app icon");
    }
    let source_ico = manifest_dir.join("icons/icon.ico");
    let windows_icon = if source_ico.is_file() {
        source_ico
    } else {
        fallback_icon
    };
    let windows = tauri_build::WindowsAttributes::new().window_icon_path(windows_icon);
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// A valid 1x1, transparent 32-bit ICO. It is only a compile-time fallback;
/// production packaging should provide a branded icon through the release
/// pipeline and update `window_icon_path` accordingly.
fn fallback_ico() -> [u8; 70] {
    [
        // ICONDIR: reserved, type (icon), image count.
        0, 0, 1, 0, 1, 0,
        // ICONDIRENTRY: 1x1, no palette, one plane, 32 bpp, 48-byte image.
        1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0,
        // BITMAPINFOHEADER: 1x1 BGRA image plus one-row AND mask.
        40, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // One transparent pixel and one 32-bit AND-mask row.
        0, 0, 0, 0, 0, 0, 0, 0,
    ]
}

/// A valid 1x1 RGBA PNG used by `generate_context!` when no branded icon has
/// been staged yet. The cyan pixel keeps the fallback consistent with RWANG's
/// existing web icon and is replaced by a release asset when available.
fn fallback_png() -> [u8; 70] {
    [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 72, 121, 254, 255,
        63, 0, 7, 71, 3, 74, 11, 83, 77, 236, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}

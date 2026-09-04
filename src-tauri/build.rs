mod icon_validation;

use icon_validation::{validate_ico, validate_png};
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_icon = manifest_dir.join("icons/icon.png");
    let source_ico = manifest_dir.join("icons/icon.ico");

    validate_png(&source_icon).unwrap_or_else(|error| panic!("{error}"));
    validate_ico(&source_ico).unwrap_or_else(|error| panic!("{error}"));

    let windows = tauri_build::WindowsAttributes::new().window_icon_path(source_ico);
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

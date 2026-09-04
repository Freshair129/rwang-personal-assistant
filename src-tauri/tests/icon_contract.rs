#[path = "../icon_validation.rs"]
mod icon_validation;

use icon_validation::{validate_ico, validate_png};
use std::fs::{create_dir_all, read, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn manifest_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn fixture_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "rwang-icon-contract-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must follow the Unix epoch")
            .as_nanos()
    ))
}

#[test]
fn branded_release_icons_decode_completely() {
    let (width, height) =
        validate_png(&manifest_path("icons/icon.png")).expect("checked-in branded PNG must decode");
    assert!(width >= 128 && height >= 128);
    assert!(
        validate_ico(&manifest_path("icons/icon.ico")).expect("checked-in branded ICO must decode")
            > 0
    );
}

#[test]
fn missing_truncated_and_corrupt_icons_fail_closed() {
    let root = fixture_root();
    create_dir_all(&root).expect("fixture root must be creatable");

    assert!(validate_png(&root.join("missing.png")).is_err());

    let original_png = read(manifest_path("icons/icon.png")).expect("read branded PNG");
    let truncated_png = root.join("truncated.png");
    write(&truncated_png, &original_png[..original_png.len() / 2]).expect("write truncated PNG");
    assert!(validate_png(&truncated_png).is_err());

    let mut corrupt_png_bytes = original_png;
    let idat = corrupt_png_bytes
        .windows(4)
        .position(|window| window == b"IDAT")
        .expect("branded PNG must contain IDAT");
    corrupt_png_bytes[idat + 4] ^= 0xff;
    let corrupt_png = root.join("corrupt.png");
    write(&corrupt_png, corrupt_png_bytes).expect("write corrupt PNG");
    assert!(validate_png(&corrupt_png).is_err());

    let original_ico = read(manifest_path("icons/icon.ico")).expect("read branded ICO");
    let truncated_ico = root.join("truncated.ico");
    write(&truncated_ico, &original_ico[..original_ico.len() / 2]).expect("write truncated ICO");
    assert!(validate_ico(&truncated_ico).is_err());

    let mut corrupt_ico_bytes = original_ico;
    corrupt_ico_bytes[18..22].copy_from_slice(&u32::MAX.to_le_bytes());
    let corrupt_ico = root.join("corrupt.ico");
    write(&corrupt_ico, corrupt_ico_bytes).expect("write corrupt ICO");
    assert!(validate_ico(&corrupt_ico).is_err());

    remove_dir_all(root).expect("fixture root must be removable");
}

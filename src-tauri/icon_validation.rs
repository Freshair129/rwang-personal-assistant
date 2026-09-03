use std::fs::File;
use std::io::BufReader;
use std::path::Path;

pub fn validate_png(path: &Path) -> Result<(u32, u32), String> {
    let file = File::open(path).map_err(|error| {
        format!(
            "required branded PNG icon {} is unavailable: {error}",
            path.display()
        )
    })?;
    let decoder = png::Decoder::new(BufReader::new(file));
    let mut reader = decoder.read_info().map_err(|error| {
        format!(
            "required branded PNG icon {} is invalid: {error}",
            path.display()
        )
    })?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width < 128 || height < 128 {
        return Err(format!(
            "required branded PNG icon {} must be at least 128x128, found {width}x{height}",
            path.display()
        ));
    }
    let mut pixels = vec![0; reader.output_buffer_size()];
    reader.next_frame(&mut pixels).map_err(|error| {
        format!(
            "required branded PNG icon {} cannot be decoded: {error}",
            path.display()
        )
    })?;
    Ok((width, height))
}

pub fn validate_ico(path: &Path) -> Result<usize, String> {
    let file = File::open(path).map_err(|error| {
        format!(
            "required branded ICO icon {} is unavailable: {error}",
            path.display()
        )
    })?;
    let icon = ico::IconDir::read(BufReader::new(file)).map_err(|error| {
        format!(
            "required branded ICO icon {} is invalid: {error}",
            path.display()
        )
    })?;
    if icon.entries().is_empty() {
        return Err(format!(
            "required branded ICO icon {} has no images",
            path.display()
        ));
    }

    let mut largest_dimension = 0;
    for entry in icon.entries() {
        let image = entry.decode().map_err(|error| {
            format!(
                "required branded ICO icon {} contains an invalid image: {error}",
                path.display()
            )
        })?;
        largest_dimension = largest_dimension.max(image.width()).max(image.height());
    }
    if largest_dimension < 128 {
        return Err(format!(
            "required branded ICO icon {} must contain an image at least 128px wide or high",
            path.display()
        ));
    }
    Ok(icon.entries().len())
}

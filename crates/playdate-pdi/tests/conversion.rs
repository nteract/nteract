use std::path::PathBuf;

use image::{ImageBuffer, ImageEncoder, Rgba};
use playdate_pdi::{
    normalize_image, ConversionOptions, DitherMode, PlaydatePdiConverter, PLAYDATE_PDI_MIME,
};

#[test]
fn normalizes_png_to_playdate_one_bit_pixels() {
    let png = rgba_png(&[
        (0, 0, 0, 255),
        (255, 255, 255, 255),
        (127, 127, 127, 255),
        (255, 0, 0, 0),
    ]);

    let normalized = normalize_image(
        &png,
        "image/png",
        &ConversionOptions {
            max_width: 4,
            max_height: 1,
            dither: DitherMode::Threshold,
        },
    )
    .expect("png should normalize");

    assert_eq!(normalized.width, 4);
    assert_eq!(normalized.height, 1);
    assert_eq!(
        normalized.pixels,
        vec![0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 0]
    );
    assert!(normalized.png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
}

#[test]
fn decodes_jpeg_sources_before_normalizing() {
    let pixels = [(10, 10, 10); 8]
        .into_iter()
        .chain([(240, 240, 240); 8])
        .collect::<Vec<_>>();
    let jpeg = rgb_jpeg(&pixels);

    let normalized = normalize_image(
        &jpeg,
        "image/jpeg",
        &ConversionOptions {
            max_width: 16,
            max_height: 1,
            dither: DitherMode::Threshold,
        },
    )
    .expect("jpeg should normalize");

    assert_eq!(normalized.width, 16);
    assert_eq!(normalized.height, 1);
    assert_eq!(&normalized.pixels[0..4], &[0, 0, 0, 255]);
    assert_eq!(&normalized.pixels[60..64], &[255, 255, 255, 255]);
}

#[test]
fn rejects_non_image_mime_types() {
    let err = normalize_image(
        b"not an image",
        "application/octet-stream",
        &ConversionOptions::default(),
    )
    .expect_err("non image MIME should be rejected");

    assert!(
        err.to_string().contains("unsupported image MIME"),
        "unexpected error: {err}"
    );
}

#[test]
fn invokes_pdc_and_returns_pdi_bytes_when_sdk_is_available() {
    let Some(sdk_path) = local_playdate_sdk_path() else {
        eprintln!("skipping pdc integration test: Playdate SDK not found");
        return;
    };
    let png = rgba_png(&[
        (0, 0, 0, 255),
        (255, 255, 255, 255),
        (0, 0, 0, 255),
        (255, 255, 255, 255),
    ]);
    let converter = PlaydatePdiConverter::from_sdk_path(sdk_path);

    let converted = converter
        .convert_image(&png, "image/png", &ConversionOptions::default())
        .expect("pdc should produce PDI bytes");

    assert_eq!(converted.content_type, PLAYDATE_PDI_MIME);
    assert_eq!(converted.width, 4);
    assert_eq!(converted.height, 1);
    assert!(!converted.bytes.is_empty());
    assert_eq!(converted.byte_length, converted.bytes.len());
    assert_eq!(converted.source_mime, "image/png");
}

fn rgba_png(pixels: &[(u8, u8, u8, u8)]) -> Vec<u8> {
    let image: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_fn(pixels.len() as u32, 1, |x, _| {
            let (r, g, b, a) = pixels[x as usize];
            Rgba([r, g, b, a])
        });
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .expect("encode png");
    bytes
}

fn rgb_jpeg(pixels: &[(u8, u8, u8)]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(pixels.len() * 3);
    for &(r, g, b) in pixels {
        raw.extend_from_slice(&[r, g, b]);
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100)
        .write_image(&raw, pixels.len() as u32, 1, image::ExtendedColorType::Rgb8)
        .expect("encode jpeg");
    bytes
}

fn local_playdate_sdk_path() -> Option<PathBuf> {
    std::env::var_os("PLAYDATE_SDK_PATH")
        .or_else(|| std::env::var_os("PLAYDATE_SDK"))
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Developer/PlaydateSDK"))
        })
        .filter(|path| path.join("bin/pdc").is_file())
}

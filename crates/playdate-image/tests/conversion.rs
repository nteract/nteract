use image::{ImageBuffer, ImageEncoder, Rgba, RgbaImage};
use playdate_image::{
    convert_image, pack_image, ConversionOptions, DitherMode, PLAYDATE_BITMAP_MAGIC,
    PLAYDATE_BITMAP_MIME,
};

#[test]
fn packs_png_to_playdate_bit_order() {
    let png = rgba_png(&[
        (0, 0, 0, 255),
        (255, 255, 255, 255),
        (127, 127, 127, 255),
        (255, 0, 0, 0),
        (0, 0, 0, 255),
        (255, 255, 255, 255),
        (255, 255, 255, 255),
        (0, 0, 0, 255),
    ]);

    let packed = pack_image(
        &png,
        "image/png",
        &ConversionOptions {
            max_width: 8,
            max_height: 1,
            dither: DitherMode::Threshold,
        },
    )
    .expect("png should pack");

    assert_eq!(packed.width, 8);
    assert_eq!(packed.height, 1);
    assert_eq!(packed.row_stride, 1);
    assert_eq!(packed.pixels, vec![0b0101_0110]);
}

#[test]
fn converts_plot_like_png_to_serialized_payload() {
    let png = plot_like_png();

    let converted = convert_image(
        &png,
        "image/png",
        &ConversionOptions {
            max_width: 96,
            max_height: 64,
            dither: DitherMode::Bayer4x4,
        },
    )
    .expect("plot should convert");

    assert_eq!(converted.content_type, PLAYDATE_BITMAP_MIME);
    assert_eq!(converted.width, 96);
    assert_eq!(converted.height, 64);
    assert_eq!(converted.row_stride, 12);
    assert_eq!(converted.source_mime, "image/png");
    assert_eq!(converted.byte_length, 16 + 12 * 64);
    assert_eq!(&converted.bytes[0..8], PLAYDATE_BITMAP_MAGIC);
    assert_eq!(&converted.bytes[8..10], &96_u16.to_le_bytes());
    assert_eq!(&converted.bytes[10..12], &64_u16.to_le_bytes());
    assert_eq!(&converted.bytes[12..14], &12_u16.to_le_bytes());
}

#[test]
fn decodes_jpeg_sources_before_packing() {
    let pixels = [(10, 10, 10); 8]
        .into_iter()
        .chain([(240, 240, 240); 8])
        .collect::<Vec<_>>();
    let jpeg = rgb_jpeg(&pixels);

    let packed = pack_image(
        &jpeg,
        "image/jpeg",
        &ConversionOptions {
            max_width: 16,
            max_height: 1,
            dither: DitherMode::Threshold,
        },
    )
    .expect("jpeg should pack");

    assert_eq!(packed.width, 16);
    assert_eq!(packed.height, 1);
    assert_eq!(packed.pixels, vec![0x00, 0xff]);
}

#[test]
fn rejects_non_image_mime_types() {
    let err = pack_image(
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

fn rgba_png(pixels: &[(u8, u8, u8, u8)]) -> Vec<u8> {
    let image: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_fn(pixels.len() as u32, 1, |x, _| {
            let (r, g, b, a) = pixels[x as usize];
            Rgba([r, g, b, a])
        });
    encode_rgba_png(&image)
}

fn plot_like_png() -> Vec<u8> {
    let width = 96;
    let height = 64;
    let mut image = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    let x_axis_y = height - 10;
    let y_axis_x = 9;

    for x in y_axis_x..(width - 4) {
        image.put_pixel(x, x_axis_y, Rgba([0, 0, 0, 255]));
    }
    for y in 5..=x_axis_y {
        image.put_pixel(y_axis_x, y, Rgba([0, 0, 0, 255]));
    }
    for y in (10..x_axis_y).step_by(12) {
        for x in (y_axis_x + 1)..(width - 4) {
            image.put_pixel(x, y, Rgba([220, 220, 220, 255]));
        }
    }

    for x in (y_axis_x + 2)..(width - 5) {
        let t = (x - y_axis_x - 2) as f32 / (width - y_axis_x - 7) as f32;
        let y = 31.0 - (t * std::f32::consts::TAU).sin() * 18.0;
        draw_point(&mut image, x, y.round() as u32, Rgba([24, 24, 24, 255]));
    }

    encode_rgba_png(&image)
}

fn draw_point(image: &mut RgbaImage, x: u32, y: u32, color: Rgba<u8>) {
    let width = image.width();
    let height = image.height();
    for dx in 0..=1 {
        for dy in 0..=1 {
            let px = x + dx;
            let py = y + dy;
            if px < width && py < height {
                image.put_pixel(px, py, color);
            }
        }
    }
}

fn encode_rgba_png(image: &RgbaImage) -> Vec<u8> {
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

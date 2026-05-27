//! Playdate-oriented notebook image conversion.
//!
//! This crate is intentionally SDK-free: it decodes common notebook image bytes
//! in Rust and emits a compact 1-bit payload that a Playdate viewer can render
//! directly. A native Playdate renderer can copy rows into `get_frame()` output
//! or into an `LCDBitmap` data buffer, then call `mark_updated_rows()`.

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, RgbaImage};
use thiserror::Error;

pub const PLAYDATE_BITMAP_MIME: &str = "application/x-nteract-playdate-bitmap";
pub const PLAYDATE_BITMAP_MAGIC: &[u8; 8] = b"NTPDIMG1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DitherMode {
    Threshold,
    Bayer2x2,
    Bayer4x4,
    Bayer8x8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionOptions {
    pub max_width: u32,
    pub max_height: u32,
    pub dither: DitherMode,
}

impl Default for ConversionOptions {
    fn default() -> Self {
        Self {
            max_width: 400,
            max_height: 240,
            dither: DitherMode::Bayer4x4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaydateBitmap {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub row_stride: u16,
    pub byte_length: usize,
    pub content_type: &'static str,
    pub source_mime: String,
    pub dither: DitherMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackedBitmap {
    pub width: u32,
    pub height: u32,
    pub row_stride: u16,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum PlaydateImageError {
    #[error("unsupported image MIME type: {0}")]
    UnsupportedMime(String),
    #[error("invalid conversion dimensions: max_width={max_width}, max_height={max_height}")]
    InvalidDimensions { max_width: u32, max_height: u32 },
    #[error("image is too large for Playdate bitmap payload: width={width}, height={height}")]
    ImageTooLarge { width: u32, height: u32 },
    #[error("failed to decode {mime} image: {source}")]
    Decode {
        mime: String,
        #[source]
        source: image::ImageError,
    },
}

pub fn convert_image(
    input: &[u8],
    source_mime: &str,
    options: &ConversionOptions,
) -> Result<PlaydateBitmap, PlaydateImageError> {
    let bitmap = pack_image(input, source_mime, options)?;
    let bytes = encode_playdate_bitmap(&bitmap);
    let byte_length = bytes.len();

    Ok(PlaydateBitmap {
        bytes,
        width: bitmap.width,
        height: bitmap.height,
        row_stride: bitmap.row_stride,
        byte_length,
        content_type: PLAYDATE_BITMAP_MIME,
        source_mime: source_mime.to_string(),
        dither: options.dither,
    })
}

pub fn pack_image(
    input: &[u8],
    source_mime: &str,
    options: &ConversionOptions,
) -> Result<PackedBitmap, PlaydateImageError> {
    if options.max_width == 0 || options.max_height == 0 {
        return Err(PlaydateImageError::InvalidDimensions {
            max_width: options.max_width,
            max_height: options.max_height,
        });
    }

    let format = image_format_for_mime(source_mime)
        .ok_or_else(|| PlaydateImageError::UnsupportedMime(source_mime.to_string()))?;
    let decoded = image::load_from_memory_with_format(input, format).map_err(|source| {
        PlaydateImageError::Decode {
            mime: source_mime.to_string(),
            source,
        }
    })?;
    let resized = resize_to_fit(decoded, options.max_width, options.max_height);
    let (width, height) = resized.dimensions();
    if width > u32::from(u16::MAX) || height > u32::from(u16::MAX) {
        return Err(PlaydateImageError::ImageTooLarge { width, height });
    }
    let mut rgba = resized.to_rgba8();
    let row_stride = row_stride(width, height, false)?;
    let pixels = pack_rgba_image(&mut rgba, row_stride, options.dither);

    Ok(PackedBitmap {
        width,
        height,
        row_stride,
        pixels,
    })
}

/// Encodes a simple little-endian payload:
///
/// - 8 bytes magic: `NTPDIMG1`
/// - u16 width
/// - u16 height
/// - u16 row stride in bytes
/// - u16 flags, currently 0
/// - packed 1-bit rows, MSB first, white=1 and black=0
pub fn encode_playdate_bitmap(bitmap: &PackedBitmap) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(16 + bitmap.pixels.len());
    bytes.extend_from_slice(PLAYDATE_BITMAP_MAGIC);
    bytes.extend_from_slice(&(bitmap.width as u16).to_le_bytes());
    bytes.extend_from_slice(&(bitmap.height as u16).to_le_bytes());
    bytes.extend_from_slice(&bitmap.row_stride.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&bitmap.pixels);
    bytes
}

fn image_format_for_mime(mime: &str) -> Option<ImageFormat> {
    match mime {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/gif" => Some(ImageFormat::Gif),
        "image/webp" => Some(ImageFormat::WebP),
        _ => None,
    }
}

fn resize_to_fit(image: DynamicImage, max_width: u32, max_height: u32) -> DynamicImage {
    let (width, height) = image.dimensions();
    if width <= max_width && height <= max_height {
        return image;
    }
    image.resize(max_width, max_height, FilterType::Triangle)
}

fn row_stride(
    width: u32,
    height: u32,
    align_to_playdate_framebuffer: bool,
) -> Result<u16, PlaydateImageError> {
    let bytes = width.div_ceil(8);
    let aligned = if align_to_playdate_framebuffer {
        bytes.div_ceil(4) * 4
    } else {
        bytes
    };
    u16::try_from(aligned).map_err(|_| PlaydateImageError::ImageTooLarge { width, height })
}

fn pack_rgba_image(image: &mut RgbaImage, row_stride: u16, mode: DitherMode) -> Vec<u8> {
    let width = image.width();
    let height = image.height();
    let row_stride = usize::from(row_stride);
    let mut packed = vec![0_u8; row_stride * height as usize];

    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let [red, green, blue, alpha] = pixel.0;
        let visible = alpha != 0;
        let luminance =
            ((u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114) / 1000) as u8;
        let threshold = dither_threshold(mode, x, y);
        let white = !visible || luminance >= threshold;

        if white {
            let offset = y as usize * row_stride + x as usize / 8;
            packed[offset] |= 0x80 >> (x % 8);
        }
    }

    // Make padding bits white so partial trailing bytes do not render as black
    // if a viewer blits full bytes into a wider target.
    let padding_bits = width % 8;
    if padding_bits != 0 {
        let mask = (1 << (8 - padding_bits)) - 1;
        for y in 0..height as usize {
            let offset = y * row_stride + width as usize / 8;
            packed[offset] |= mask;
        }
    }

    packed
}

fn dither_threshold(mode: DitherMode, x: u32, y: u32) -> u8 {
    match mode {
        DitherMode::Threshold => 128,
        DitherMode::Bayer2x2 => threshold_from_matrix(&BAYER_2X2, 2, x, y),
        DitherMode::Bayer4x4 => threshold_from_matrix(&BAYER_4X4, 4, x, y),
        DitherMode::Bayer8x8 => threshold_from_matrix(&BAYER_8X8, 8, x, y),
    }
}

fn threshold_from_matrix(matrix: &[u8], side: u32, x: u32, y: u32) -> u8 {
    let index = ((y % side) * side + (x % side)) as usize;
    let rank = u16::from(matrix[index]);
    let cells = (side * side) as u16;
    (((rank * 256) + 128) / cells) as u8
}

const BAYER_2X2: [u8; 4] = [0, 2, 3, 1];

const BAYER_4X4: [u8; 16] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const BAYER_8X8: [u8; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

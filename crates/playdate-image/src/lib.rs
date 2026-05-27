//! Playdate-oriented notebook image conversion.
//!
//! This crate is intentionally SDK-free: it decodes common notebook image bytes
//! in Rust and emits a compact 1-bit payload that a Playdate viewer can render
//! directly. A native Playdate renderer can copy rows into `get_frame()` output
//! or into an `LCDBitmap` data buffer, then call `mark_updated_rows()`.

use std::io::Cursor;

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits, RgbaImage};
use thiserror::Error;

pub const PLAYDATE_BITMAP_MIME: &str = "application/x-nteract-playdate-bitmap";
pub const PLAYDATE_BITMAP_MAGIC: &[u8; 8] = b"NTPDIMG1";
pub const PLAYDATE_BITMAP_HEADER_LEN: usize = 16;
pub const PLAYDATE_BITMAP_FLAG_HAS_MASK: u16 = 0x0001;
pub const DEFAULT_MAX_DECODE_WIDTH: u32 = 1600;
pub const DEFAULT_MAX_DECODE_HEIGHT: u32 = 960;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;

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
    pub max_decode_width: u32,
    pub max_decode_height: u32,
    pub max_output_bytes: usize,
    pub dither: DitherMode,
}

impl Default for ConversionOptions {
    fn default() -> Self {
        Self {
            max_width: 400,
            max_height: 240,
            max_decode_width: DEFAULT_MAX_DECODE_WIDTH,
            max_decode_height: DEFAULT_MAX_DECODE_HEIGHT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
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
    pub has_mask: bool,
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
    pub mask: Option<Vec<u8>>,
}

#[derive(Debug, Error)]
pub enum PlaydateImageError {
    #[error("unsupported image MIME type: {0}")]
    UnsupportedMime(String),
    #[error(
        "invalid conversion dimensions: max_width={max_width}, max_height={max_height}, max_decode_width={max_decode_width}, max_decode_height={max_decode_height}"
    )]
    InvalidDimensions {
        max_width: u32,
        max_height: u32,
        max_decode_width: u32,
        max_decode_height: u32,
    },
    #[error("image is too large for Playdate bitmap payload: width={width}, height={height}")]
    ImageTooLarge { width: u32, height: u32 },
    #[error(
        "converted Playdate bitmap payload is too large: byte_length={byte_length}, max_byte_length={max_byte_length}"
    )]
    PayloadTooLarge {
        byte_length: usize,
        max_byte_length: usize,
    },
    #[error("invalid Playdate bitmap data: {0}")]
    InvalidBitmapData(&'static str),
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
    let bytes = encode_playdate_bitmap(&bitmap)?;
    let byte_length = bytes.len();

    Ok(PlaydateBitmap {
        bytes,
        width: bitmap.width,
        height: bitmap.height,
        row_stride: bitmap.row_stride,
        byte_length,
        has_mask: bitmap.mask.is_some(),
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
    if options.max_width == 0
        || options.max_height == 0
        || options.max_decode_width == 0
        || options.max_decode_height == 0
    {
        return Err(PlaydateImageError::InvalidDimensions {
            max_width: options.max_width,
            max_height: options.max_height,
            max_decode_width: options.max_decode_width,
            max_decode_height: options.max_decode_height,
        });
    }

    let format = image_format_for_mime(source_mime)
        .ok_or_else(|| PlaydateImageError::UnsupportedMime(source_mime.to_string()))?;
    let decoded = decode_with_limits(input, format, source_mime, options)?;
    let resized = resize_to_fit(decoded, options.max_width, options.max_height);
    let (width, height) = resized.dimensions();
    if width > u32::from(u16::MAX) || height > u32::from(u16::MAX) {
        return Err(PlaydateImageError::ImageTooLarge { width, height });
    }
    let rgba = resized.to_rgba8();
    let row_stride = row_stride(width, height, false)?;
    let pixel_byte_length = usize::from(row_stride).checked_mul(height as usize).ok_or(
        PlaydateImageError::PayloadTooLarge {
            byte_length: usize::MAX,
            max_byte_length: options.max_output_bytes,
        },
    )?;
    let has_mask = rgba.pixels().any(|pixel| pixel.0[3] < 128);
    let mask_byte_length = if has_mask { pixel_byte_length } else { 0 };
    let byte_length = PLAYDATE_BITMAP_HEADER_LEN
        .checked_add(pixel_byte_length)
        .and_then(|length| length.checked_add(mask_byte_length))
        .ok_or(PlaydateImageError::PayloadTooLarge {
            byte_length: usize::MAX,
            max_byte_length: options.max_output_bytes,
        })?;
    if byte_length > options.max_output_bytes {
        return Err(PlaydateImageError::PayloadTooLarge {
            byte_length,
            max_byte_length: options.max_output_bytes,
        });
    }
    let (pixels, mask) = pack_rgba_image(&rgba, row_stride, options.dither, has_mask);

    Ok(PackedBitmap {
        width,
        height,
        row_stride,
        pixels,
        mask,
    })
}

/// Encodes a simple little-endian payload:
///
/// - 8 bytes magic: `NTPDIMG1`
/// - u16 width
/// - u16 height
/// - u16 row stride in bytes
/// - u16 flags, bit 0 means an alpha mask plane follows the color plane
/// - packed 1-bit rows, MSB first, white=1 and black=0
/// - optional packed alpha rows, MSB first, opaque=1 and transparent=0
pub fn encode_playdate_bitmap(bitmap: &PackedBitmap) -> Result<Vec<u8>, PlaydateImageError> {
    if bitmap.width > u32::from(u16::MAX) || bitmap.height > u32::from(u16::MAX) {
        return Err(PlaydateImageError::ImageTooLarge {
            width: bitmap.width,
            height: bitmap.height,
        });
    }
    let min_row_stride = bitmap.width.div_ceil(8);
    if u32::from(bitmap.row_stride) < min_row_stride {
        return Err(PlaydateImageError::InvalidBitmapData(
            "row_stride is too small for width",
        ));
    }
    let pixel_byte_length = usize::from(bitmap.row_stride)
        .checked_mul(bitmap.height as usize)
        .ok_or(PlaydateImageError::InvalidBitmapData("bitmap is too large"))?;
    if bitmap.pixels.len() != pixel_byte_length {
        return Err(PlaydateImageError::InvalidBitmapData(
            "color plane length does not match row_stride * height",
        ));
    }
    if let Some(mask) = &bitmap.mask {
        if mask.len() != pixel_byte_length {
            return Err(PlaydateImageError::InvalidBitmapData(
                "mask plane length does not match row_stride * height",
            ));
        }
    }

    let flags = if bitmap.mask.is_some() {
        PLAYDATE_BITMAP_FLAG_HAS_MASK
    } else {
        0
    };
    let mask_len = bitmap.mask.as_ref().map_or(0, Vec::len);
    let mut bytes = Vec::with_capacity(PLAYDATE_BITMAP_HEADER_LEN + bitmap.pixels.len() + mask_len);
    bytes.extend_from_slice(PLAYDATE_BITMAP_MAGIC);
    bytes.extend_from_slice(&(bitmap.width as u16).to_le_bytes());
    bytes.extend_from_slice(&(bitmap.height as u16).to_le_bytes());
    bytes.extend_from_slice(&bitmap.row_stride.to_le_bytes());
    bytes.extend_from_slice(&flags.to_le_bytes());
    bytes.extend_from_slice(&bitmap.pixels);
    if let Some(mask) = &bitmap.mask {
        bytes.extend_from_slice(mask);
    }
    Ok(bytes)
}

fn decode_with_limits(
    input: &[u8],
    format: ImageFormat,
    source_mime: &str,
    options: &ConversionOptions,
) -> Result<DynamicImage, PlaydateImageError> {
    let max_alloc = u64::from(options.max_decode_width)
        .saturating_mul(u64::from(options.max_decode_height))
        .saturating_mul(4);
    let mut reader = ImageReader::with_format(Cursor::new(input), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(options.max_decode_width);
    limits.max_image_height = Some(options.max_decode_height);
    limits.max_alloc = Some(max_alloc);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|source| PlaydateImageError::Decode {
            mime: source_mime.to_string(),
            source,
        })
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

fn pack_rgba_image(
    image: &RgbaImage,
    row_stride: u16,
    mode: DitherMode,
    include_mask: bool,
) -> (Vec<u8>, Option<Vec<u8>>) {
    let width = image.width();
    let height = image.height();
    let row_stride = usize::from(row_stride);
    let mut packed = vec![0_u8; row_stride * height as usize];
    let mut mask = include_mask.then(|| vec![0_u8; row_stride * height as usize]);

    for (x, y, pixel) in image.enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let luminance =
            ((u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114) / 1000) as u8;
        let threshold = dither_threshold(mode, x, y);
        let white = luminance >= threshold;
        let offset = y as usize * row_stride + x as usize / 8;
        let bit = 0x80 >> (x % 8);

        if white {
            packed[offset] |= bit;
        }
        if alpha >= 128 {
            if let Some(mask) = &mut mask {
                mask[offset] |= bit;
            }
        }
    }

    // Make padding bits white so partial trailing bytes do not render as black
    // if a viewer blits full bytes into a wider target.
    let padding_bits = width % 8;
    if padding_bits != 0 {
        let pad_mask = (1 << (8 - padding_bits)) - 1;
        for y in 0..height as usize {
            let offset = y * row_stride + width as usize / 8;
            packed[offset] |= pad_mask;
        }
    }

    if let Some(alpha_mask) = &mut mask {
        set_padding_bits(alpha_mask, width, height, row_stride);
    }

    (packed, mask)
}

fn set_padding_bits(packed: &mut [u8], width: u32, height: u32, row_stride: usize) {
    let padding_bits = width % 8;
    if padding_bits == 0 {
        return;
    }
    let mask = (1 << (8 - padding_bits)) - 1;
    for y in 0..height as usize {
        let offset = y * row_stride + width as usize / 8;
        packed[offset] |= mask;
    }
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

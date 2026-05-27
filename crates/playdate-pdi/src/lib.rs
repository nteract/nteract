//! Playdate PDI conversion.
//!
//! The Playdate SDK does not document PDI as a stable write format. This crate
//! decodes common notebook image bytes in Rust, normalizes them to
//! Playdate-safe 1-bit PNG, then asks the SDK compiler (`pdc`) to produce the
//! final PDI bytes.

use std::path::{Path, PathBuf};
use std::process::Command;

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageEncoder, ImageFormat, RgbaImage};
use thiserror::Error;

pub const PLAYDATE_PDI_MIME: &str = "image/x-playdate-pdi";

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
pub struct NormalizedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    pub png_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdiImage {
    pub bytes: Vec<u8>,
    pub byte_length: usize,
    pub width: u32,
    pub height: u32,
    pub content_type: &'static str,
    pub source_mime: String,
    pub dither: DitherMode,
}

#[derive(Debug, Clone)]
pub struct PlaydatePdiConverter {
    pdc_path: PathBuf,
}

impl PlaydatePdiConverter {
    pub fn from_sdk_path(path: impl AsRef<Path>) -> Self {
        Self {
            pdc_path: path.as_ref().join("bin/pdc"),
        }
    }

    pub fn from_pdc_path(path: impl Into<PathBuf>) -> Self {
        Self {
            pdc_path: path.into(),
        }
    }

    pub fn convert_image(
        &self,
        input: &[u8],
        source_mime: &str,
        options: &ConversionOptions,
    ) -> Result<PdiImage, PlaydatePdiError> {
        let normalized = normalize_image(input, source_mime, options)?;
        let tempdir = tempfile::tempdir()?;
        let source_path = tempdir.path().join("source.png");
        let output_base = tempdir.path().join("compiled");
        std::fs::write(&source_path, &normalized.png_bytes)?;

        let output = Command::new(&self.pdc_path)
            .arg(&source_path)
            .arg(&output_base)
            .output()
            .map_err(|source| PlaydatePdiError::PdcSpawn {
                pdc_path: self.pdc_path.clone(),
                source,
            })?;

        if !output.status.success() {
            return Err(PlaydatePdiError::PdcFailed {
                status: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }

        let pdi_path = output_base.with_extension("pdx").join("source.pdi");
        let bytes = std::fs::read(&pdi_path)
            .map_err(|source| PlaydatePdiError::MissingPdi { pdi_path, source })?;
        let byte_length = bytes.len();
        Ok(PdiImage {
            bytes,
            byte_length,
            width: normalized.width,
            height: normalized.height,
            content_type: PLAYDATE_PDI_MIME,
            source_mime: source_mime.to_string(),
            dither: options.dither,
        })
    }
}

#[derive(Debug, Error)]
pub enum PlaydatePdiError {
    #[error("unsupported image MIME type: {0}")]
    UnsupportedMime(String),
    #[error("invalid conversion dimensions: max_width={max_width}, max_height={max_height}")]
    InvalidDimensions { max_width: u32, max_height: u32 },
    #[error("failed to decode {mime} image: {source}")]
    Decode {
        mime: String,
        #[source]
        source: image::ImageError,
    },
    #[error("failed to encode normalized PNG: {0}")]
    Encode(#[from] image::ImageError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to spawn pdc at {pdc_path}: {source}")]
    PdcSpawn {
        pdc_path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("pdc failed with status {status:?}: {stderr}{stdout}")]
    PdcFailed {
        status: Option<i32>,
        stdout: String,
        stderr: String,
    },
    #[error("pdc did not produce expected PDI at {pdi_path}: {source}")]
    MissingPdi {
        pdi_path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub fn normalize_image(
    input: &[u8],
    source_mime: &str,
    options: &ConversionOptions,
) -> Result<NormalizedImage, PlaydatePdiError> {
    if options.max_width == 0 || options.max_height == 0 {
        return Err(PlaydatePdiError::InvalidDimensions {
            max_width: options.max_width,
            max_height: options.max_height,
        });
    }

    let format = image_format_for_mime(source_mime)
        .ok_or_else(|| PlaydatePdiError::UnsupportedMime(source_mime.to_string()))?;
    let decoded = image::load_from_memory_with_format(input, format).map_err(|source| {
        PlaydatePdiError::Decode {
            mime: source_mime.to_string(),
            source,
        }
    })?;
    let resized = resize_to_fit(decoded, options.max_width, options.max_height);
    let (width, height) = resized.dimensions();
    let mut pixels = resized.to_rgba8();
    apply_one_bit_dither(&mut pixels, options.dither);

    let raw = pixels.into_raw();
    let mut png_bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png_bytes).write_image(
        &raw,
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )?;

    Ok(NormalizedImage {
        width,
        height,
        pixels: raw,
        png_bytes,
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

fn apply_one_bit_dither(image: &mut RgbaImage, mode: DitherMode) {
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let [red, green, blue, alpha] = pixel.0;
        if alpha == 0 {
            pixel.0 = [255, 255, 255, 0];
            continue;
        }

        let luminance =
            ((u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114) / 1000) as u8;
        let threshold = dither_threshold(mode, x, y);
        pixel.0 = if luminance < threshold {
            [0, 0, 0, 255]
        } else {
            [255, 255, 255, 255]
        };
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

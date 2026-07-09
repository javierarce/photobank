//! Pure image processing: decode → EXIF → bake orientation → resize →
//! encode jpg+webp variants with the source's ICC profile re-embedded.
//! Mirrors the old sharp worker (src/worker/process-image.ts): autoOrient,
//! keepIccProfile, quality 85, withoutEnlargement.

use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::metadata::Orientation;
use image::RgbImage;
use img_parts::ImageICC;

use crate::error::{Error, Result};
use crate::exif::{self, ExifMeta};
use crate::keys::{variant_key, VariantFormat, VARIANT_FORMATS, VARIANT_WIDTHS};

const QUALITY: u8 = 85;

pub struct Variant {
    pub key: String,
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

pub struct ProcessedImage {
    /// Dimensions as displayed, i.e. after EXIF orientation is applied.
    pub width: u32,
    pub height: u32,
    pub exif: ExifMeta,
    pub variants: Vec<Variant>,
}

/// Extensions the importer accepts. HEIC/RAW are out of scope for v1.
pub const IMPORT_EXTENSIONS: [&str; 8] =
    ["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp"];

pub fn is_importable(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .map(|ext| IMPORT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// CPU-bound; call from spawn_blocking.
pub fn process(bytes: &[u8], s3_key: &str) -> Result<ProcessedImage> {
    let meta = exif::parse(bytes);
    let icc = img_parts::DynImage::from_bytes(bytes.to_vec().into())
        .ok()
        .flatten()
        .and_then(|img| img.icc_profile());

    let mut decoded = image::load_from_memory(bytes)
        .map_err(|e| Error::msg(format!("could not decode image: {e}")))?;

    // Bake the orientation into the pixels — output formats carry no EXIF,
    // so without this portraits render sideways (same as sharp autoOrient).
    if let Some(orientation) = Orientation::from_exif(meta.orientation) {
        decoded.apply_orientation(orientation);
    }

    let rgb = decoded.to_rgb8();
    let (width, height) = rgb.dimensions();

    let mut variants = Vec::with_capacity(VARIANT_WIDTHS.len() * 2);
    for target_width in VARIANT_WIDTHS {
        let resized = resize_to_width(&rgb, target_width)?;
        for format in VARIANT_FORMATS {
            let encoded = encode(&resized, format, icc.as_deref())?;
            variants.push(Variant {
                key: variant_key(s3_key, target_width, format),
                bytes: encoded,
                content_type: format.content_type(),
            });
        }
    }

    Ok(ProcessedImage {
        width,
        height,
        exif: meta,
        variants,
    })
}

/// Lanczos3 downscale to `target_width`, never enlarging (sharp's
/// withoutEnlargement: smaller sources keep their size).
fn resize_to_width(rgb: &RgbImage, target_width: u32) -> Result<RgbImage> {
    let (width, height) = rgb.dimensions();
    if width <= target_width {
        return Ok(rgb.clone());
    }
    let target_height =
        ((height as f64) * (target_width as f64) / (width as f64)).round().max(1.0) as u32;

    let src = FirImage::from_vec_u8(width, height, rgb.as_raw().clone(), PixelType::U8x3)
        .map_err(|e| Error::msg(format!("resize input: {e}")))?;
    let mut dst = FirImage::new(target_width, target_height, PixelType::U8x3);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| Error::msg(format!("resize: {e}")))?;

    RgbImage::from_raw(target_width, target_height, dst.into_vec())
        .ok_or_else(|| Error::msg("resize produced an invalid buffer"))
}

fn encode(rgb: &RgbImage, format: VariantFormat, icc: Option<&[u8]>) -> Result<Vec<u8>> {
    let (width, height) = rgb.dimensions();
    let plain = match format {
        VariantFormat::Jpg => {
            let mut out = Vec::new();
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY);
            rgb.write_with_encoder(encoder)
                .map_err(|e| Error::msg(format!("jpeg encode: {e}")))?;
            out
        }
        VariantFormat::Webp => {
            let encoder = webp::Encoder::from_rgb(rgb.as_raw(), width, height);
            encoder.encode(QUALITY as f32).to_vec()
        }
    };

    // Preserve color profiles like Display P3 (sharp keepIccProfile). sRGB
    // and profile-less sources pass through unchanged.
    let Some(icc) = icc else { return Ok(plain) };
    embed_icc(plain, format, icc)
}

fn embed_icc(encoded: Vec<u8>, format: VariantFormat, icc: &[u8]) -> Result<Vec<u8>> {
    let icc = img_parts::Bytes::copy_from_slice(icc);
    let mut out = Vec::new();
    match format {
        VariantFormat::Jpg => {
            let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(encoded.into())
                .map_err(|e| Error::msg(format!("icc embed (jpeg): {e}")))?;
            jpeg.set_icc_profile(Some(icc));
            jpeg.encoder()
                .write_to(&mut out)
                .map_err(|e| Error::msg(format!("icc write (jpeg): {e}")))?;
        }
        VariantFormat::Webp => {
            let mut webp_img = img_parts::webp::WebP::from_bytes(encoded.into())
                .map_err(|e| Error::msg(format!("icc embed (webp): {e}")))?;
            webp_img.set_icc_profile(Some(icc));
            webp_img
                .encoder()
                .write_to(&mut out)
                .map_err(|e| Error::msg(format!("icc write (webp): {e}")))?;
        }
    }
    Ok(out)
}

pub fn mime_for_extension(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "tif" | "tiff" => Some("image/tiff"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 100x50 gradient so resizing has real content to chew on.
    fn test_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut out = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
        img.write_with_encoder(encoder).unwrap();
        out
    }

    #[test]
    fn produces_all_six_variants_with_correct_keys() {
        let bytes = test_jpeg(100, 50);
        let processed = process(&bytes, "inbox/tiny.jpg").unwrap();

        assert_eq!(processed.width, 100);
        assert_eq!(processed.height, 50);
        assert_eq!(processed.variants.len(), 6);
        let keys: Vec<_> = processed.variants.iter().map(|v| v.key.as_str()).collect();
        assert!(keys.contains(&"inbox/tiny_640.jpg"));
        assert!(keys.contains(&"inbox/tiny_640.webp"));
        assert!(keys.contains(&"inbox/tiny_2880.webp"));
    }

    #[test]
    fn small_sources_are_never_enlarged() {
        let bytes = test_jpeg(100, 50);
        let processed = process(&bytes, "inbox/tiny.jpg").unwrap();

        for variant in &processed.variants {
            let decoded = image::load_from_memory(&variant.bytes).unwrap();
            assert_eq!(decoded.width(), 100, "variant {} was enlarged", variant.key);
            assert_eq!(decoded.height(), 50);
        }
    }

    #[test]
    fn large_sources_downscale_preserving_aspect_ratio() {
        let bytes = test_jpeg(1600, 900);
        let processed = process(&bytes, "inbox/wide.jpg").unwrap();

        let v640 = processed
            .variants
            .iter()
            .find(|v| v.key.ends_with("_640.webp"))
            .unwrap();
        let decoded = image::load_from_memory(&v640.bytes).unwrap();
        assert_eq!(decoded.width(), 640);
        assert_eq!(decoded.height(), 360);

        // 2880 > 1600, so that variant stays at the source size
        let v2880 = processed
            .variants
            .iter()
            .find(|v| v.key.ends_with("_2880.jpg"))
            .unwrap();
        let decoded = image::load_from_memory(&v2880.bytes).unwrap();
        assert_eq!(decoded.width(), 1600);
    }

    #[test]
    fn variants_are_really_jpeg_and_webp() {
        let bytes = test_jpeg(100, 50);
        let processed = process(&bytes, "inbox/tiny.jpg").unwrap();

        for variant in &processed.variants {
            if variant.key.ends_with(".jpg") {
                assert_eq!(&variant.bytes[..2], &[0xFF, 0xD8], "jpeg magic");
            } else {
                assert_eq!(&variant.bytes[..4], b"RIFF", "webp riff header");
                assert_eq!(&variant.bytes[8..12], b"WEBP", "webp fourcc");
            }
        }
    }

    #[test]
    fn icc_profile_is_reembedded_into_variants() {
        // Build a jpeg with a (dummy but structurally valid) ICC payload
        let plain = test_jpeg(200, 100);
        let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(plain.into()).unwrap();
        let fake_icc = img_parts::Bytes::from_static(b"fake-icc-profile-payload");
        jpeg.set_icc_profile(Some(fake_icc.clone()));
        let mut with_icc = Vec::new();
        jpeg.encoder().write_to(&mut with_icc).unwrap();

        let processed = process(&with_icc, "inbox/p3.jpg").unwrap();
        for variant in &processed.variants {
            let parsed = img_parts::DynImage::from_bytes(variant.bytes.clone().into())
                .unwrap()
                .unwrap();
            assert_eq!(
                parsed.icc_profile().as_deref(),
                Some(fake_icc.as_ref()),
                "variant {} lost the ICC profile",
                variant.key
            );
        }
    }

    #[test]
    fn importable_extension_filter() {
        assert!(is_importable("/a/b/photo.JPG"));
        assert!(is_importable("/a/b/photo.webp"));
        assert!(!is_importable("/a/b/movie.mp4"));
        assert!(!is_importable("/a/b/photo.heic"));
        assert!(!is_importable("/a/b/noext"));
    }
}

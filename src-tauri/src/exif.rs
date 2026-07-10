//! EXIF extraction matching what the old worker stored (see
//! src/worker/process-image.ts + src/worker/exif.ts): make, model, lens,
//! focal length "50mm", aperture "f/1.8", shutter "1/250s", ISO, taken-at,
//! GPS as signed decimals, plus the orientation used by the pipeline.

use exif::{In, Tag, Value};

#[derive(Debug, Clone, Default)]
pub struct ExifMeta {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens: Option<String>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<i64>,
    pub taken_at: Option<String>,
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    /// EXIF orientation 1–8; 1 when absent.
    pub orientation: u8,
}

pub fn parse(bytes: &[u8]) -> ExifMeta {
    let mut meta = ExifMeta {
        orientation: 1,
        ..Default::default()
    };

    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes))
    else {
        return meta;
    };

    meta.camera_make = ascii(&exif, Tag::Make);
    meta.camera_model = ascii(&exif, Tag::Model);
    meta.lens = ascii(&exif, Tag::LensModel);
    meta.focal_length = rational(&exif, Tag::FocalLength).map(|v| format!("{}mm", fmt_num(v)));
    meta.aperture = rational(&exif, Tag::FNumber).map(|v| format!("f/{}", fmt_num(v)));
    meta.shutter_speed = rational(&exif, Tag::ExposureTime)
        .filter(|v| *v > 0.0)
        .map(format_shutter_speed);
    meta.iso = uint(&exif, Tag::PhotographicSensitivity).map(|v| v as i64);
    meta.taken_at = ascii(&exif, Tag::DateTimeOriginal).and_then(|raw| datetime_to_iso(&raw));
    meta.orientation = uint(&exif, Tag::Orientation)
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1) as u8;

    meta.gps_latitude = gps_decimal(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef);
    meta.gps_longitude = gps_decimal(&exif, Tag::GPSLongitude, Tag::GPSLongitudeRef);

    meta
}

fn ascii(exif: &exif::Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    match &field.value {
        Value::Ascii(chunks) => {
            let raw = chunks.first()?;
            let text = String::from_utf8_lossy(raw).trim().to_string();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn rational(exif: &exif::Exif, tag: Tag) -> Option<f64> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    match &field.value {
        Value::Rational(values) => {
            let r = values.first()?;
            (r.denom != 0).then(|| r.to_f64())
        }
        Value::SRational(values) => {
            let r = values.first()?;
            (r.denom != 0).then(|| r.to_f64())
        }
        _ => None,
    }
}

fn uint(exif: &exif::Exif, tag: Tag) -> Option<u32> {
    exif.get_field(tag, In::PRIMARY)?.value.get_uint(0)
}

/// "2024:06:01 18:30:05" -> "2024-06-01T18:30:05.000Z". EXIF has no
/// timezone; the old exif-reader treated the value as UTC, so we do too.
fn datetime_to_iso(raw: &str) -> Option<String> {
    let (date, time) = raw.trim().split_once(' ')?;
    let mut date_parts = date.split(':');
    let (y, m, d) = (
        date_parts.next()?.parse::<u16>().ok()?,
        date_parts.next()?.parse::<u8>().ok()?,
        date_parts.next()?.parse::<u8>().ok()?,
    );
    let mut time_parts = time.split(':');
    let (h, mi, s) = (
        time_parts.next()?.parse::<u8>().ok()?,
        time_parts.next()?.parse::<u8>().ok()?,
        time_parts.next()?.parse::<u8>().ok()?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.000Z"
    ))
}

/// EXIF stores GPS coordinates as [degrees, minutes, seconds] plus a
/// hemisphere ref ("N"/"S"/"E"/"W"). Convert to a signed decimal — mirrors
/// gpsToDecimal in src/worker/exif.ts.
fn gps_decimal(exif: &exif::Exif, coord_tag: Tag, ref_tag: Tag) -> Option<f64> {
    let field = exif.get_field(coord_tag, In::PRIMARY)?;
    let Value::Rational(values) = &field.value else {
        return None;
    };
    if values.len() != 3 || values.iter().any(|r| r.denom == 0) {
        return None;
    }
    let (deg, min, sec) = (values[0].to_f64(), values[1].to_f64(), values[2].to_f64());
    if ![deg, min, sec].iter().all(|v| v.is_finite()) {
        return None;
    }
    let decimal = deg + min / 60.0 + sec / 3600.0;
    let reference = ascii(exif, ref_tag);
    match reference.as_deref() {
        Some("S") | Some("W") => Some(-decimal),
        _ => Some(decimal),
    }
}

/// Mirrors formatShutterSpeed in src/worker/exif.ts.
pub fn format_shutter_speed(exposure_time: f64) -> String {
    if exposure_time >= 1.0 {
        format!("{}s", fmt_num(exposure_time))
    } else {
        format!("1/{}s", (1.0 / exposure_time).round() as i64)
    }
}

/// Format like JS number-to-string: integers without a decimal point.
fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutter_speed_formats_match_the_web_worker() {
        assert_eq!(format_shutter_speed(2.0), "2s");
        assert_eq!(format_shutter_speed(1.5), "1.5s");
        assert_eq!(format_shutter_speed(1.0), "1s");
        assert_eq!(format_shutter_speed(0.004), "1/250s");
        assert_eq!(format_shutter_speed(1.0 / 3.0), "1/3s");
    }

    #[test]
    fn numbers_format_like_javascript() {
        assert_eq!(fmt_num(50.0), "50");
        assert_eq!(fmt_num(26.3), "26.3");
        assert_eq!(fmt_num(1.8), "1.8");
    }

    #[test]
    fn exif_datetime_converts_to_iso() {
        assert_eq!(
            datetime_to_iso("2024:06/01 18:30:05".replace('/', ":").as_str()),
            Some("2024-06-01T18:30:05.000Z".to_string())
        );
        assert_eq!(datetime_to_iso("garbage"), None);
        assert_eq!(datetime_to_iso("2024:13:01 00:00:00"), None);
    }

    #[test]
    fn parse_returns_defaults_for_exifless_bytes() {
        let meta = parse(b"not an image");
        assert_eq!(meta.orientation, 1);
        assert!(meta.camera_make.is_none());
        assert!(meta.taken_at.is_none());
    }
}

//! Client-side image sanitization for Blossom uploads.
//!
//! The relay enforces a metadata-free contract on image uploads
//! (`buzz_media::validation`): any JPEG APPn/COM segment, PNG textual or
//! unknown-ancillary chunk, WebP EXIF/XMP/ICCP chunk, or GIF metadata
//! extension is rejected with 422 `MetadataForbidden`. Real-world images
//! almost always carry some of these, so a client that PUTs raw bytes fails.
//! The desktop app sanitizes before upload
//! (`desktop/src-tauri/src/commands/media.rs`); this module ports that
//! behavior to the CLI so `buzz upload file` and
//! `buzz messages send --file` succeed with the same inputs.

/// tEXt keywords that carry Buzz snapshot manifests (`.agent.png` /
/// `.team.png`). Mirrors `buzz_media::validation`'s allowlist: these chunks
/// are deliberate product payloads, exempt from the metadata ban.
const PNG_SNAPSHOT_KEYWORDS: [&[u8]; 2] = [b"buzz_agent_snapshot", b"buzz_team_snapshot"];

/// Return true when a PNG contains a Buzz snapshot manifest tEXt chunk
/// (allowlisted keyword followed by the keyword/text NUL separator — the
/// exact shape `buzz_media::validation` exempts).
fn has_snapshot_text_chunk(body: &[u8]) -> bool {
    const SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !body.starts_with(SIG) {
        return false;
    }
    let mut i = SIG.len();
    while i + 12 <= body.len() {
        let len = u32::from_be_bytes(body[i..i + 4].try_into().unwrap()) as usize;
        let Some(end) = i
            .checked_add(12)
            .and_then(|v| v.checked_add(len))
            .filter(|&v| v <= body.len())
        else {
            return false;
        };
        if &body[i + 4..i + 8] == b"tEXt" {
            let payload = &body[i + 8..end - 4];
            let is_snapshot = PNG_SNAPSHOT_KEYWORDS.iter().any(|keyword| {
                payload.len() > keyword.len()
                    && &payload[..keyword.len()] == *keyword
                    && payload[keyword.len()] == 0
            });
            if is_snapshot {
                return true;
            }
        }
        i = end;
    }
    false
}

/// Return true when a PNG/WebP payload declares animation.
///
/// Ported verbatim from `desktop/src-tauri/src/commands/media.rs` so the CLI
/// detects exactly the same animated containers the desktop does.
fn is_animated_image(body: &[u8], mime: &str) -> bool {
    match mime {
        "image/png" if body.starts_with(b"\x89PNG\r\n\x1a\n") => {
            let mut offset = 8usize;
            while offset.checked_add(12).is_some_and(|end| end <= body.len()) {
                let length = u32::from_be_bytes([
                    body[offset],
                    body[offset + 1],
                    body[offset + 2],
                    body[offset + 3],
                ]) as usize;
                let Some(end) = offset.checked_add(12).and_then(|v| v.checked_add(length)) else {
                    return false;
                };
                if end > body.len() {
                    return false;
                }
                if &body[offset + 4..offset + 8] == b"acTL" {
                    return true;
                }
                offset = end;
            }
            false
        }
        "image/webp"
            if body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP" =>
        {
            let mut offset = 12usize;
            while offset.checked_add(8).is_some_and(|end| end <= body.len()) {
                let chunk = &body[offset..offset + 4];
                if chunk == b"ANIM" || chunk == b"ANMF" {
                    return true;
                }
                let length = u32::from_le_bytes([
                    body[offset + 4],
                    body[offset + 5],
                    body[offset + 6],
                    body[offset + 7],
                ]) as usize;
                let padded = length.checked_add(length & 1);
                let Some(end) = padded.and_then(|v| offset.checked_add(8 + v)) else {
                    return false;
                };
                if end > body.len() {
                    return false;
                }
                offset = end;
            }
            false
        }
        _ => false,
    }
}

/// Walk length-prefixed GIF data sub-blocks starting at `i`; return the index
/// just past the block terminator.
fn gif_sub_blocks_end(body: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let len = *body.get(i)? as usize;
        i += 1;
        if len == 0 {
            return Some(i);
        }
        i = i.checked_add(len).filter(|&end| end <= body.len())?;
    }
}

/// Strip metadata channels from a GIF without re-encoding.
///
/// Ported verbatim from `desktop/src-tauri/src/commands/media_gif.rs`. GIF
/// carries three unrestricted metadata channels — comment extensions (0xFE),
/// plain-text extensions (0x01), and application extensions (0xFF) other than
/// the standard NETSCAPE2.0/ANIMEXTS1.0 looping ones — all rejected by the
/// relay. Everything the relay accepts is copied verbatim, so animation
/// timing, disposal, and pixel data stay byte-identical. Returns `None` when
/// the payload isn't structurally parseable as GIF; the caller then keeps the
/// original bytes and the relay's validator remains the authority.
fn strip_gif_metadata(body: &[u8]) -> Option<Vec<u8>> {
    if !(body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a")) || body.len() < 13 {
        return None;
    }

    let packed = body[10];
    let mut i = 13usize;
    if packed & 0x80 != 0 {
        let table_len = 3usize << ((packed & 0x07) as usize + 1);
        i = i.checked_add(table_len).filter(|&end| end <= body.len())?;
    }

    let mut out = Vec::with_capacity(body.len());
    out.extend_from_slice(&body[..i]);

    loop {
        match *body.get(i)? {
            // Image descriptor: optional local colour table, LZW minimum code
            // size, then image-data sub-blocks. Copied verbatim.
            0x2c => {
                if i + 10 > body.len() {
                    return None;
                }
                let image_packed = body[i + 9];
                let mut end = i + 10;
                if image_packed & 0x80 != 0 {
                    let table_len = 3usize << ((image_packed & 0x07) as usize + 1);
                    end = end.checked_add(table_len).filter(|&e| e <= body.len())?;
                }
                end = end.checked_add(1).filter(|&e| e <= body.len())?;
                end = gif_sub_blocks_end(body, end)?;
                out.extend_from_slice(&body[i..end]);
                i = end;
            }
            0x21 => {
                let label = *body.get(i + 1)?;
                let start = i;
                i += 2;
                match label {
                    // Graphic Control Extension: fixed-shape rendering state
                    // (delay, disposal, transparency). Kept verbatim.
                    0xf9 => {
                        if body.get(i) != Some(&4) || i + 6 > body.len() || body[i + 5] != 0 {
                            return None;
                        }
                        i += 6;
                        out.extend_from_slice(&body[start..i]);
                    }
                    // Application extension: keep only the standard looping
                    // extensions; anything else (XMP, Photoshop, Giphy…) is a
                    // metadata channel and is dropped.
                    0xff => {
                        if body.get(i) != Some(&11) || i + 12 > body.len() {
                            return None;
                        }
                        let app = &body[i + 1..i + 12];
                        let keep = app == b"NETSCAPE2.0" || app == b"ANIMEXTS1.0";
                        let data_start = i + 12;
                        i = gif_sub_blocks_end(body, data_start)?;
                        if keep {
                            if body.get(data_start) != Some(&3)
                                || body.get(data_start + 1) != Some(&1)
                                || data_start.checked_add(5)? > body.len()
                            {
                                return None;
                            }
                            out.extend_from_slice(&body[start..data_start + 4]);
                            out.push(0);
                        }
                    }
                    // Comment (0xFE), plain-text (0x01), and unknown
                    // extensions: pure metadata channels, dropped. Their
                    // bodies are all length-prefixed sub-block sequences
                    // (plain-text's 12-byte header is itself a sub-block).
                    _ => {
                        i = gif_sub_blocks_end(body, i)?;
                    }
                }
            }
            // Trailer: emit and stop, truncating any trailing bytes.
            0x3b => {
                out.push(0x3b);
                return Some(out);
            }
            _ => return None,
        }
    }
}

/// Sanitize image bytes for upload to the relay's metadata-free contract.
///
/// Ports the desktop sanitizer (`desktop/src-tauri/src/commands/media.rs`)
/// with CLI-specific scope decisions:
///
/// - Static JPEG/PNG/WebP are decoded, EXIF orientation baked in, and
///   re-encoded in the same format — which strips all metadata. Identical to
///   desktop, error strings included.
/// - GIF is stripped structurally (never re-encoded — that would destroy
///   animation timing), identical to desktop.
/// - Animated PNG (acTL) and animated WebP (ANIM/ANMF) are PASSED THROUGH
///   unchanged. The desktop runs 693-line structural strippers for these;
///   the CLI deliberately does not port them — the relay's validator stays
///   the authority for animated containers.
/// - A PNG carrying a Buzz snapshot manifest tEXt chunk is PASSED THROUGH
///   unchanged. Unlike desktop (which extracts and re-injects the chunk
///   around the re-encode), the CLI keeps the bytes identical: producer
///   output is already canonical, and re-encoding risks destroying the
///   manifest for no sanitization gain.
/// - Any other MIME (video/mp4, application/octet-stream, …) is returned
///   unchanged — the sanitizer only owns the image formats above.
///
/// Unlike the desktop, unparseable/undecodable payloads on the re-encode
/// path return `Err` rather than passing through: the CLI should tell the
/// caller the file could not be sanitized instead of uploading bytes it
/// knows the relay will reject.
pub fn sanitize_image_for_upload(body: Vec<u8>, mime: &str) -> Result<Vec<u8>, String> {
    let format = match mime {
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/png" => image::ImageFormat::Png,
        "image/webp" => image::ImageFormat::WebP,
        // GIF is never re-encoded (that would destroy animation timing);
        // metadata extensions are stripped structurally instead. Unparseable
        // payloads pass through — the relay's validator is the authority.
        "image/gif" => {
            let stripped = strip_gif_metadata(&body);
            return Ok(stripped.unwrap_or(body));
        }
        _ => return Ok(body),
    };

    // Animated PNG/WebP pass through unchanged (see doc comment).
    if is_animated_image(&body, mime) {
        return Ok(body);
    }

    // Snapshot-manifest PNGs pass through unchanged (see doc comment).
    if format == image::ImageFormat::Png && has_snapshot_text_chunk(&body) {
        return Ok(body);
    }
    use image::ImageDecoder;
    let reader = image::ImageReader::with_format(std::io::Cursor::new(&body), format);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "failed to decode image for metadata removal".to_string())?;
    decoder
        .set_limits(image::Limits::default())
        .map_err(|_| "image exceeds safe decoding limits".to_string())?;
    let orientation = decoder
        .orientation()
        .map_err(|_| "failed to read image orientation".to_string())?;
    let mut image = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "failed to decode image for metadata removal".to_string())?;
    image.apply_orientation(orientation);
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, format)
        .map_err(|_| "failed to encode image without metadata".to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_media::{MediaConfig, MediaError, S3AddressingStyle};

    /// Copy of buzz-media's `test_config()` shape — the relay's real upload
    /// limits, so `validate_content` behaves exactly as it does on the wire.
    fn test_config() -> MediaConfig {
        MediaConfig {
            s3_endpoint: String::new(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            s3_bucket: String::new(),
            s3_region: "us-east-1".to_string(),
            s3_addressing_style: S3AddressingStyle::Path,
            max_image_bytes: 50 * 1024 * 1024,
            max_gif_bytes: 10 * 1024 * 1024,
            max_video_bytes: 524_288_000,
            max_file_bytes: 104_857_600,
            public_base_url: String::new(),
            upload_records_enabled: false,
            upload_ip_header: None,
            upload_port_header: None,
        }
    }

    /// Standard CRC-32 (PNG chunk CRC) — computed, not hardcoded, so the
    /// fixtures stay honest when edited.
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in data {
            crc ^= byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// Build a PNG chunk (length + kind + payload + valid CRC).
    fn png_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        let mut crc_input = Vec::new();
        crc_input.extend_from_slice(kind);
        crc_input.extend_from_slice(payload);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        out
    }

    /// Encode a real 2×2 RGB PNG with the `image` crate — a fully valid,
    /// decodable, canonical container.
    fn clean_png() -> Vec<u8> {
        let image =
            image::RgbImage::from_fn(2, 2, |x, y| image::Rgb([x as u8 * 80, y as u8 * 60, 32]));
        let mut out = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    /// Splice extra chunks into a PNG right after IHDR (before IDAT).
    fn splice_after_ihdr(png: &[u8], extra: &[u8]) -> Vec<u8> {
        // sig (8) + IHDR chunk (12 + 13)
        let split = 8 + 25;
        let mut out = png[..split].to_vec();
        out.extend_from_slice(extra);
        out.extend_from_slice(&png[split..]);
        out
    }

    /// Encode a real 2×2 JPEG with the `image` crate.
    fn clean_jpeg() -> Vec<u8> {
        let image =
            image::RgbImage::from_fn(2, 2, |x, y| image::Rgb([x as u8 * 80, y as u8 * 60, 32]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95)
            .encode_image(&image)
            .unwrap();
        out
    }

    /// Minimal single-frame GIF89a (ported from the desktop media_gif tests).
    /// Structurally canonical — the relay's validator accepts exactly this
    /// shape.
    fn minimal_gif() -> Vec<u8> {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[
            0x02, 0x00, 0x02, 0x00, // logical screen 2×2
            0x80, 0x00, 0x00, // GCT flag, 2 entries
            0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // colour table
        ]);
        // NETSCAPE2.0 looping application extension.
        gif.extend_from_slice(&[0x21, 0xff, 11]);
        gif.extend_from_slice(b"NETSCAPE2.0");
        gif.extend_from_slice(&[3, 0x01, 0x00, 0x00, 0x00]);
        // Graphic control extension.
        gif.extend_from_slice(&[0x21, 0xf9, 4, 0x00, 0x0a, 0x00, 0x00, 0x00]);
        // Image descriptor + 2-bit LZW data.
        gif.extend_from_slice(&[0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00]);
        gif.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
        gif.push(0x3b);
        gif
    }

    #[test]
    fn png_with_phys_chunk_is_sanitized_and_passes_relay_validation() {
        let config = test_config();
        // pHYs payload: 1 pixel per metre in both axes, unit = metre.
        let dirty = splice_after_ihdr(
            &clean_png(),
            &png_chunk(b"pHYs", &[0, 0, 0, 1, 0, 0, 0, 1, 1]),
        );

        // Discriminating pair: the dirty input must fail the real relay
        // validator with MetadataForbidden…
        let err = buzz_media::validation::validate_content(&dirty, &config).unwrap_err();
        assert!(matches!(err, MediaError::MetadataForbidden), "got {err:?}");
        // …and the sanitized output must pass it.
        let out = sanitize_image_for_upload(dirty, "image/png").unwrap();
        assert_eq!(
            buzz_media::validation::validate_content(&out, &config).unwrap(),
            "image/png"
        );
    }

    #[test]
    fn jpeg_with_app1_exif_is_sanitized_and_passes_relay_validation() {
        let config = test_config();
        let encoded = clean_jpeg();
        // Minimal little-endian Exif IFD with Orientation=1.
        let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&[
            0x11, 0x01, // Orientation tag
            0x03, 0x00, // SHORT
            0x01, 0x00, 0x00, 0x00, // count=1
            0x01, 0x00, 0x00, 0x00, // value=1
            0x00, 0x00, 0x00, 0x00, // next IFD
        ]);
        let segment_len = (exif.len() + 2) as u16;
        let mut dirty = encoded[..2].to_vec();
        dirty.extend_from_slice(&[0xff, 0xe1]);
        dirty.extend_from_slice(&segment_len.to_be_bytes());
        dirty.extend_from_slice(&exif);
        dirty.extend_from_slice(&encoded[2..]);

        let err = buzz_media::validation::validate_content(&dirty, &config).unwrap_err();
        assert!(matches!(err, MediaError::MetadataForbidden), "got {err:?}");
        let out = sanitize_image_for_upload(dirty, "image/jpeg").unwrap();
        assert_eq!(
            buzz_media::validation::validate_content(&out, &config).unwrap(),
            "image/jpeg"
        );
    }

    #[test]
    fn gif_with_comment_extension_is_stripped_to_the_clean_gif() {
        let config = test_config();
        let clean = minimal_gif();
        // Splice a comment extension after the global colour table (offset 19).
        let mut dirty = clean[..19].to_vec();
        dirty.extend_from_slice(&[0x21, 0xfe, 5]);
        dirty.extend_from_slice(b"hello");
        dirty.push(0);
        dirty.extend_from_slice(&clean[19..]);

        let out = sanitize_image_for_upload(dirty, "image/gif").unwrap();
        assert_eq!(out, clean);
        assert_eq!(
            buzz_media::validation::validate_content(&out, &config).unwrap(),
            "image/gif"
        );
    }

    #[test]
    fn clean_png_still_passes_after_sanitization() {
        let config = test_config();
        let out = sanitize_image_for_upload(clean_png(), "image/png").unwrap();
        assert_eq!(
            buzz_media::validation::validate_content(&out, &config).unwrap(),
            "image/png"
        );
    }

    #[test]
    fn png_with_snapshot_text_chunk_passes_through_byte_identical() {
        let mut payload = b"buzz_agent_snapshot\0".to_vec();
        payload.extend_from_slice(br#"{"version":1}"#);
        let png = splice_after_ihdr(&clean_png(), &png_chunk(b"tEXt", &payload));

        let out = sanitize_image_for_upload(png.clone(), "image/png").unwrap();
        assert_eq!(out, png);
    }

    #[test]
    fn animated_png_with_actl_passes_through_byte_identical() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&8u32.to_be_bytes());
        png.extend_from_slice(b"acTL");
        png.extend_from_slice(&[0; 8]);
        png.extend_from_slice(&[0; 4]);

        let out = sanitize_image_for_upload(png.clone(), "image/png").unwrap();
        assert_eq!(out, png);
    }

    #[test]
    fn unparseable_jpeg_claimed_as_jpeg_is_an_error() {
        let junk = b"definitely not a jpeg".to_vec();
        let err = sanitize_image_for_upload(junk, "image/jpeg").unwrap_err();
        assert!(
            err.contains("failed to decode image"),
            "unexpected error: {err}"
        );
    }
}

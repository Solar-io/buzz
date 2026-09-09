//! Client-side image sanitization for the upload path.
//!
//! The relay rejects media carrying metadata (`MetadataForbidden` in
//! `validation.rs`) — uploaded images must be metadata-free by the time they
//! leave the client. The desktop composer has always sanitized before upload;
//! this module is the same sanitizer as a library so the CLI (and any other
//! client) can attach a photo without ceremony: no exiftool, no spell.
//!
//! Two strategies, mirroring the desktop implementation:
//!
//! - **Still images** (JPEG/PNG/WebP) are decoded with orientation applied,
//!   then re-encoded — a canonical, metadata-free payload by construction.
//! - **Animated payloads** (GIF, APNG, animated WebP) must never be re-encoded
//!   (`image::DynamicImage` keeps only the first frame, and GIF re-encode
//!   destroys timing), so metadata channels are stripped structurally while
//!   rendering chunks are copied byte-for-byte.
//!
//! Unparseable payloads pass through unchanged — the relay's validator remains
//! the authority on every path.

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const PNG_ALLOWED_ANCILLARY: &[[u8; 4]] = &[
    *b"cHRM", *b"gAMA", *b"sBIT", *b"sRGB", *b"bKGD", *b"hIST", *b"tRNS", *b"sPLT", *b"acTL",
    *b"fcTL", *b"fdAT",
];
const WEBP_ALLOWED_CHUNKS: &[[u8; 4]] =
    &[*b"VP8 ", *b"VP8L", *b"VP8X", *b"ALPH", *b"ANIM", *b"ANMF"];
const WEBP_METADATA_FLAGS: u8 = 0x20 | 0x08 | 0x04;

/// Sanitize an image for upload: strip every metadata channel the relay's
/// validator forbids, preserving rendering exactly where stripping would
/// change what the viewer sees.
///
/// `mime` must be one of the image types the upload path accepts
/// (`image/jpeg`, `image/png`, `image/webp`, `image/gif`); anything else is
/// returned unchanged for the caller's own validation path.
///
/// Returns an error only when the payload cannot be sanitized without
/// changing its appearance (animated PNG/WebP that rely on EXIF orientation
/// or an ICC profile) — the caller surfaces that as a user-facing refusal,
/// not a silent visual change.
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

    if is_animated_image(&body, mime) {
        let oriented_format = match mime {
            "image/png" if animated_png_uses_exif_orientation(&body) => Some("PNG"),
            "image/webp" if animated_webp_uses_exif_orientation(&body) => Some("WebP"),
            _ => None,
        };
        if let Some(format) = oriented_format {
            return Err(format!(
                "animated {format} with EXIF orientation cannot be uploaded without changing its appearance"
            ));
        }
        let color_profile_format = match mime {
            "image/png" if animated_png_uses_icc_profile(&body) => Some("PNG"),
            "image/webp" if animated_webp_uses_icc_profile(&body) => Some("WebP"),
            _ => None,
        };
        if let Some(format) = color_profile_format {
            return Err(format!(
                "animated {format} with an ICC profile cannot be uploaded without changing its colors"
            ));
        }
        let stripped = match mime {
            "image/png" => strip_animated_png_metadata(&body),
            "image/webp" => strip_animated_webp_metadata(&body),
            _ => None,
        };
        return Ok(stripped.unwrap_or(body));
    }

    // Still image: decode, apply orientation, re-encode — a metadata-free
    // payload by construction. A payload the decoder cannot handle (or that
    // exceeds its limits) passes through unchanged: exotic-but-clean files
    // keep uploading exactly as before, and anything that genuinely carries
    // metadata is rejected by the relay's validator, which remains the
    // authority on every path. This differs deliberately from the desktop
    // composer, which surfaces a decode failure to its user — a library
    // client feeding arbitrary files fails open to the authority instead.
    Ok(reencode_still(&body, format).unwrap_or(body))
}

/// Decode a still image, apply EXIF orientation, re-encode in the same format
/// — producing a canonical metadata-free payload. Returns `None` on any
/// decode/encode failure; the caller then passes the original bytes through
/// and the relay's validator stays the authority.
fn reencode_still(body: &[u8], format: image::ImageFormat) -> Option<Vec<u8>> {
    use image::ImageDecoder;
    let reader = image::ImageReader::with_format(std::io::Cursor::new(body), format);
    let mut decoder = reader.into_decoder().ok()?;
    decoder.set_limits(image::Limits::default()).ok()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = image::DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    let mut output = std::io::Cursor::new(Vec::new());
    image.write_to(&mut output, format).ok()?;
    Some(output.into_inner())
}

/// Return true when a PNG/WebP payload declares animation.
///
/// Animated payloads use structural sanitizers so frame timing, looping, and
/// disposal semantics are preserved without flattening the image.
fn is_animated_image(body: &[u8], mime: &str) -> bool {
    match mime {
        "image/png" if body.starts_with(PNG_SIGNATURE) => {
            let mut offset = PNG_SIGNATURE.len();
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

// ---------------------------------------------------------------------------
// GIF — structural strip
// ---------------------------------------------------------------------------

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
/// GIF carries three unrestricted metadata channels — comment extensions
/// (0xFE), plain-text extensions (0x01), and application extensions (0xFF)
/// other than the standard NETSCAPE2.0/ANIMEXTS1.0 looping ones. The relay
/// rejects all of them (`MetadataForbidden` in `validate_gif_metadata_free`),
/// and encoders like Photoshop and Giphy emit them routinely, so uploads fail
/// unless the client drops them first.
///
/// Everything the relay accepts — header, colour tables, graphic-control
/// extensions, image descriptors and frame data, standard looping extensions —
/// is copied verbatim, so animation timing, disposal, and pixel data stay
/// byte-identical. Trailing bytes after the trailer (another relay reject) are
/// truncated. Returns `None` when the payload isn't structurally parseable as
/// GIF; the caller then uploads the original bytes and the relay's validator
/// remains the authority.
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

// ---------------------------------------------------------------------------
// Animated PNG / WebP — structural strip
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum TiffEndian {
    Little,
    Big,
}

fn tiff_u16(bytes: &[u8], offset: usize, endian: TiffEndian) -> Option<u16> {
    let value: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(match endian {
        TiffEndian::Little => u16::from_le_bytes(value),
        TiffEndian::Big => u16::from_be_bytes(value),
    })
}

fn tiff_u32(bytes: &[u8], offset: usize, endian: TiffEndian) -> Option<u32> {
    let value: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(match endian {
        TiffEndian::Little => u32::from_le_bytes(value),
        TiffEndian::Big => u32::from_be_bytes(value),
    })
}

fn exif_orientation(payload: &[u8]) -> Option<u16> {
    let tiff = payload.strip_prefix(b"Exif\0\0").unwrap_or(payload);
    let endian = match tiff.get(..2)? {
        b"II" => TiffEndian::Little,
        b"MM" => TiffEndian::Big,
        _ => return None,
    };
    if tiff_u16(tiff, 2, endian)? != 42 {
        return None;
    }

    let ifd_offset = usize::try_from(tiff_u32(tiff, 4, endian)?).ok()?;
    let entry_count = usize::from(tiff_u16(tiff, ifd_offset, endian)?);
    let entries_start = ifd_offset.checked_add(2)?;
    for index in 0..entry_count {
        let entry = entries_start.checked_add(index.checked_mul(12)?)?;
        if tiff_u16(tiff, entry, endian)? == 0x0112
            && tiff_u16(tiff, entry.checked_add(2)?, endian)? == 3
            && tiff_u32(tiff, entry.checked_add(4)?, endian)? == 1
        {
            return tiff_u16(tiff, entry.checked_add(8)?, endian);
        }
    }
    None
}

fn png_contains_chunk(body: &[u8], target: &[u8; 4]) -> bool {
    if !body.starts_with(PNG_SIGNATURE) {
        return false;
    }

    let mut offset = PNG_SIGNATURE.len();
    while offset < body.len() {
        let Some(header_end) = offset.checked_add(8).filter(|&end| end <= body.len()) else {
            return false;
        };
        let Some(payload_len) = body
            .get(offset..offset + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_be_bytes)
            .and_then(|length| usize::try_from(length).ok())
        else {
            return false;
        };
        let Some(kind) = body.get(offset + 4..header_end) else {
            return false;
        };
        let Some(chunk_end) = header_end
            .checked_add(payload_len)
            .and_then(|end| end.checked_add(4))
            .filter(|&end| end <= body.len())
        else {
            return false;
        };
        if kind == target {
            return true;
        }
        offset = chunk_end;
        if kind == b"IEND" {
            return false;
        }
    }
    false
}

fn webp_contains_top_level_chunk(body: &[u8], target: &[u8; 4]) -> bool {
    if body.len() < 12 || &body[..4] != b"RIFF" || &body[8..12] != b"WEBP" {
        return false;
    }
    let Some(declared) = body
        .get(4..8)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u32::from_le_bytes)
        .and_then(|length| usize::try_from(length).ok())
    else {
        return false;
    };
    let Some(input_end) = declared
        .checked_add(8)
        .filter(|&end| (12..=body.len()).contains(&end))
    else {
        return false;
    };

    let mut offset = 12usize;
    while offset < input_end {
        let Some(header_end) = offset.checked_add(8).filter(|&end| end <= input_end) else {
            return false;
        };
        let Some(kind) = body.get(offset..offset + 4) else {
            return false;
        };
        let Some(payload_len) = body
            .get(offset + 4..header_end)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
            .and_then(|length| usize::try_from(length).ok())
        else {
            return false;
        };
        let Some(chunk_end) = payload_len
            .checked_add(payload_len & 1)
            .and_then(|length| header_end.checked_add(length))
            .filter(|&end| end <= input_end)
        else {
            return false;
        };
        if kind == target {
            return true;
        }
        offset = chunk_end;
    }
    false
}

/// Return true when removing an APNG ICC profile would change color rendering.
fn animated_png_uses_icc_profile(body: &[u8]) -> bool {
    png_contains_chunk(body, b"iCCP")
}

/// Return true when removing an animated WebP ICC profile would change colors.
fn animated_webp_uses_icc_profile(body: &[u8]) -> bool {
    webp_contains_top_level_chunk(body, b"ICCP")
}

/// Return true when an animated PNG relies on eXIf to rotate or mirror frames.
fn animated_png_uses_exif_orientation(body: &[u8]) -> bool {
    if !body.starts_with(PNG_SIGNATURE) {
        return false;
    }

    let mut offset = PNG_SIGNATURE.len();
    while offset < body.len() {
        let Some(header_end) = offset.checked_add(8).filter(|&end| end <= body.len()) else {
            return false;
        };
        let Some(payload_len) = body
            .get(offset..offset + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_be_bytes)
            .and_then(|length| usize::try_from(length).ok())
        else {
            return false;
        };
        let Some(kind) = body.get(offset + 4..header_end) else {
            return false;
        };
        let payload_start = header_end;
        let Some(chunk_end) = payload_start
            .checked_add(payload_len)
            .and_then(|end| end.checked_add(4))
            .filter(|&end| end <= body.len())
        else {
            return false;
        };
        if kind == b"eXIf"
            && exif_orientation(&body[payload_start..payload_start + payload_len])
                .is_some_and(|orientation| (2..=8).contains(&orientation))
        {
            return true;
        }
        offset = chunk_end;
        if kind == b"IEND" {
            return false;
        }
    }
    false
}

/// Return true when a WebP relies on EXIF to rotate or mirror its frames.
///
/// Structural metadata removal cannot bake this transform without decoding
/// and re-encoding every frame, so callers must reject this uncommon case
/// rather than silently changing how the animation renders.
fn animated_webp_uses_exif_orientation(body: &[u8]) -> bool {
    if body.len() < 12 || &body[..4] != b"RIFF" || &body[8..12] != b"WEBP" {
        return false;
    }
    let Some(declared) = body
        .get(4..8)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u32::from_le_bytes)
        .and_then(|length| usize::try_from(length).ok())
    else {
        return false;
    };
    let Some(input_end) = declared
        .checked_add(8)
        .filter(|&end| (12..=body.len()).contains(&end))
    else {
        return false;
    };

    let mut offset = 12usize;
    while offset < input_end {
        let Some(header_end) = offset.checked_add(8).filter(|&end| end <= input_end) else {
            return false;
        };
        let Some(kind) = body.get(offset..offset + 4) else {
            return false;
        };
        let Some(payload_len) = body
            .get(offset + 4..header_end)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
            .and_then(|length| usize::try_from(length).ok())
        else {
            return false;
        };
        let payload_start = header_end;
        let Some(chunk_end) = payload_len
            .checked_add(payload_len & 1)
            .and_then(|length| payload_start.checked_add(length))
            .filter(|&end| end <= input_end)
        else {
            return false;
        };
        if kind == b"EXIF"
            && exif_orientation(&body[payload_start..payload_start + payload_len])
                .is_some_and(|orientation| (2..=8).contains(&orientation))
        {
            return true;
        }
        offset = chunk_end;
    }
    false
}

/// Strip metadata-bearing ancillary chunks from a PNG without touching frame
/// control or image data. Bytes after `IEND` are truncated.
fn strip_animated_png_metadata(body: &[u8]) -> Option<Vec<u8>> {
    if !body.starts_with(PNG_SIGNATURE) {
        return None;
    }

    let mut output = Vec::with_capacity(body.len());
    output.extend_from_slice(PNG_SIGNATURE);
    let mut offset = PNG_SIGNATURE.len();

    while offset < body.len() {
        let header_end = offset.checked_add(8)?;
        if header_end > body.len() {
            return None;
        }
        let payload_len = u32::from_be_bytes(body[offset..offset + 4].try_into().ok()?) as usize;
        let kind: [u8; 4] = body[offset + 4..offset + 8].try_into().ok()?;
        let chunk_end = offset
            .checked_add(12)?
            .checked_add(payload_len)
            .filter(|&end| end <= body.len())?;

        let ancillary = kind[0] & 0x20 != 0;
        if !ancillary || PNG_ALLOWED_ANCILLARY.contains(&kind) {
            output.extend_from_slice(&body[offset..chunk_end]);
        }

        offset = chunk_end;
        if kind == *b"IEND" {
            return Some(output);
        }
    }

    None
}

fn append_webp_chunk(output: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) -> Option<()> {
    output.extend_from_slice(kind);
    output.extend_from_slice(&u32::try_from(payload.len()).ok()?.to_le_bytes());
    output.extend_from_slice(payload);
    if payload.len() & 1 != 0 {
        output.push(0);
    }
    Some(())
}

fn strip_anmf_metadata(payload: &[u8]) -> Option<Vec<u8>> {
    const FRAME_HEADER_LEN: usize = 16;
    if payload.len() < FRAME_HEADER_LEN {
        return None;
    }

    let mut output = Vec::with_capacity(payload.len());
    output.extend_from_slice(&payload[..FRAME_HEADER_LEN]);
    let mut offset = FRAME_HEADER_LEN;
    let mut saw_alpha = false;
    let mut saw_image = false;

    while offset < payload.len() {
        let header_end = offset.checked_add(8).filter(|&end| end <= payload.len())?;
        let kind: [u8; 4] = payload[offset..offset + 4].try_into().ok()?;
        let chunk_len =
            u32::from_le_bytes(payload[offset + 4..header_end].try_into().ok()?) as usize;
        let chunk_start = header_end;
        let chunk_end = chunk_len
            .checked_add(chunk_len & 1)
            .and_then(|length| chunk_start.checked_add(length))
            .filter(|&end| end <= payload.len())?;
        let chunk_payload = &payload[chunk_start..chunk_start + chunk_len];

        match &kind {
            b"ALPH" if !saw_alpha && !saw_image => {
                append_webp_chunk(&mut output, &kind, chunk_payload)?;
                saw_alpha = true;
            }
            b"VP8 " if !saw_image => {
                append_webp_chunk(&mut output, &kind, chunk_payload)?;
                saw_image = true;
            }
            b"VP8L" if !saw_alpha && !saw_image => {
                append_webp_chunk(&mut output, &kind, chunk_payload)?;
                saw_image = true;
            }
            b"ALPH" | b"VP8 " | b"VP8L" => return None,
            _ => {}
        }

        offset = chunk_end;
    }

    saw_image.then_some(output)
}

/// Strip metadata chunks and flags from a WebP container while retaining all
/// still/animated rendering chunks. RIFF padding is canonicalized to zero and
/// the container length is rewritten after removals.
fn strip_animated_webp_metadata(body: &[u8]) -> Option<Vec<u8>> {
    if body.len() < 12 || &body[..4] != b"RIFF" || &body[8..12] != b"WEBP" {
        return None;
    }

    let declared = u32::from_le_bytes(body[4..8].try_into().ok()?) as usize;
    let input_end = declared
        .checked_add(8)
        .filter(|&end| (12..=body.len()).contains(&end))?;
    let mut output = Vec::with_capacity(input_end);
    output.extend_from_slice(b"RIFF\0\0\0\0WEBP");
    let mut offset = 12usize;

    while offset < input_end {
        if offset.checked_add(8)? > input_end {
            return None;
        }
        let kind: [u8; 4] = body[offset..offset + 4].try_into().ok()?;
        let payload_len =
            u32::from_le_bytes(body[offset + 4..offset + 8].try_into().ok()?) as usize;
        let payload_start = offset + 8;
        let padded_len = payload_len.checked_add(payload_len & 1)?;
        let chunk_end = payload_start
            .checked_add(padded_len)
            .filter(|&end| end <= input_end)?;

        if WEBP_ALLOWED_CHUNKS.contains(&kind) {
            if kind == *b"VP8X" {
                let (&flags, rest) =
                    body[payload_start..payload_start + payload_len].split_first()?;
                let mut payload = Vec::with_capacity(payload_len);
                payload.push(flags & !WEBP_METADATA_FLAGS);
                payload.extend_from_slice(rest);
                append_webp_chunk(&mut output, &kind, &payload)?;
            } else if kind == *b"ANMF" {
                let payload =
                    strip_anmf_metadata(&body[payload_start..payload_start + payload_len])?;
                append_webp_chunk(&mut output, &kind, &payload)?;
            } else {
                append_webp_chunk(
                    &mut output,
                    &kind,
                    &body[payload_start..payload_start + payload_len],
                )?;
            }
        }

        offset = chunk_end;
    }

    let riff_len = u32::try_from(output.len().checked_sub(8)?).ok()?;
    output[4..8].copy_from_slice(&riff_len.to_le_bytes());
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> crate::config::MediaConfig {
        crate::config::MediaConfig {
            s3_endpoint: String::new(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            s3_bucket: String::new(),
            s3_region: "us-east-1".to_string(),
            s3_addressing_style: crate::config::S3AddressingStyle::Path,
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

    /// Minimal little-endian TIFF IFD carrying an orientation entry.
    fn exif_orientation_payload(orientation: u16) -> Vec<u8> {
        let mut tiff = vec![
            b'I', b'I', 0x2a, 0x00, // II magic
            0x08, 0x00, 0x00, 0x00, // IFD offset = 8
            0x01, 0x00, // 1 entry
        ];
        tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation tag
        tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes()); // count = 1
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]); // entry padding
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        payload
    }

    fn png_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut chunk = (payload.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(payload);
        chunk.extend_from_slice(&[0, 0, 0, 0]); // CRC placeholder — not validated here
        chunk
    }

    fn animated_png(metadata: bool) -> Vec<u8> {
        let mut body = PNG_SIGNATURE.to_vec();
        body.extend_from_slice(&png_chunk(b"IHDR", &[0; 13]));
        body.extend_from_slice(&png_chunk(b"acTL", &[1, 0, 0, 0, 0, 0, 0, 0]));
        if metadata {
            body.extend_from_slice(&png_chunk(b"tEXt", b"comment"));
        }
        body.extend_from_slice(&png_chunk(b"fcTL", &[0; 26]));
        body.extend_from_slice(&png_chunk(b"fdAT", &[0, 0, 0, 1, 0xFF]));
        body.extend_from_slice(&png_chunk(b"IEND", &[]));
        body
    }

    fn webp_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut chunk = kind.to_vec();
        chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        chunk.extend_from_slice(payload);
        if payload.len() & 1 != 0 {
            chunk.push(0);
        }
        chunk
    }

    fn animated_webp(metadata: bool) -> Vec<u8> {
        let mut body = b"RIFF".to_vec();
        body.extend_from_slice(&[0, 0, 0, 0]); // length patched below
        body.extend_from_slice(b"WEBP");
        // Clean files carry only the animation flag; metadata-carrying files
        // announce their EXIF/ICC/XMP channels in the VP8X flags too.
        let flags = if metadata { 0x2f } else { 0x02 };
        body.extend_from_slice(&webp_chunk(b"VP8X", &[flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        body.extend_from_slice(&webp_chunk(b"ANIM", &[0; 6]));
        if metadata {
            body.extend_from_slice(&webp_chunk(b"EXIF", b"x".repeat(5).as_slice()));
        }
        // Frame: 16-byte ANMF header then the frame's image sub-chunk — the
        // stripper requires exactly one VP8/VP8L per frame.
        let mut anmf = vec![0u8; 16];
        anmf.extend_from_slice(&webp_chunk(b"VP8L", &[0x2f, 0x00, 0x00, 0x00]));
        body.extend_from_slice(&webp_chunk(b"ANMF", &anmf));
        let riff_len = (body.len() - 8) as u32;
        body[4..8].copy_from_slice(&riff_len.to_le_bytes());
        body
    }

    /// A clean JPEG with a hand-injected APP1 EXIF segment — the exact shape
    /// a phone photo (or any EXIF-carrying upload) presents to the relay.
    fn jpeg_with_exif() -> Vec<u8> {
        let mut clean = Vec::new();
        let img = image::DynamicImage::new_rgb8(4, 4);
        image::DynamicImage::write_to(&img, std::io::Cursor::new(&mut clean), image::ImageFormat::Jpeg)
            .unwrap();
        assert!(clean.starts_with(&[0xff, 0xd8]));

        let exif = exif_orientation_payload(6);
        let mut infected = vec![0xff, 0xd8];
        infected.push(0xff);
        infected.push(0xe1); // APP1
        infected.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        infected.extend_from_slice(&exif);
        infected.extend_from_slice(&clean[2..]);
        infected
    }

    #[test]
    fn exif_jpeg_is_rejected_raw_and_passes_after_sanitize() {
        let config = test_config();
        let raw = jpeg_with_exif();

        // Without sanitization the relay validator rejects the payload —
        // this is the 422 every raw CLI upload hit.
        let err = crate::validation::validate_content(&raw, &config)
            .expect_err("raw EXIF JPEG must be rejected by the validator");
        assert!(
            matches!(err, crate::error::MediaError::MetadataForbidden),
            "expected MetadataForbidden, got {err:?}"
        );

        // Sanitized, the same image passes cleanly.
        let clean = sanitize_image_for_upload(raw.clone(), "image/jpeg")
            .expect("sanitize must succeed");
        let mime = crate::validation::validate_content(&clean, &config)
            .expect("sanitized JPEG must pass the validator");
        assert_eq!(mime, "image/jpeg");
    }

    #[test]
    fn sanitize_changes_the_bytes_of_a_dirty_jpeg() {
        let raw = jpeg_with_exif();
        let clean =
            sanitize_image_for_upload(raw.clone(), "image/jpeg").expect("sanitize must succeed");
        assert_ne!(
            raw, clean,
            "sanitization must actually rewrite an EXIF-carrying JPEG"
        );
    }

    #[test]
    fn strip_animated_png_metadata_preserves_animation_chunks() {
        let dirty = animated_png(true);
        let clean = strip_animated_png_metadata(&dirty).expect("must parse");
        assert!(png_contains_chunk(&clean, b"acTL"));
        assert!(png_contains_chunk(&clean, b"fcTL"));
        assert!(png_contains_chunk(&clean, b"fdAT"));
        assert!(!png_contains_chunk(&clean, b"tEXt"));
    }

    #[test]
    fn strip_animated_png_metadata_is_byte_identical_for_clean_input() {
        let clean_input = animated_png(false);
        let stripped = strip_animated_png_metadata(&clean_input).expect("must parse");
        assert_eq!(clean_input, stripped);
    }

    #[test]
    fn strip_animated_webp_metadata_preserves_animation_chunks() {
        let dirty = animated_webp(true);
        let clean = strip_animated_webp_metadata(&dirty).expect("must parse");
        assert!(webp_contains_top_level_chunk(&clean, b"ANIM"));
        assert!(webp_contains_top_level_chunk(&clean, b"ANMF"));
        assert!(!webp_contains_top_level_chunk(&clean, b"EXIF"));
        // VP8X metadata flags are cleared.
        assert_eq!(clean[20] & WEBP_METADATA_FLAGS, 0);
    }

    #[test]
    fn strip_animated_webp_metadata_is_byte_identical_for_clean_input() {
        let clean_input = animated_webp(false);
        let stripped = strip_animated_webp_metadata(&clean_input).expect("must parse");
        assert_eq!(clean_input, stripped);
    }

    #[test]
    fn detects_non_identity_animated_webp_exif_orientation() {
        // Animated WebP carrying EXIF orientation 6.
        let mut with_exif = b"RIFF".to_vec();
        with_exif.extend_from_slice(&[0, 0, 0, 0]);
        with_exif.extend_from_slice(b"WEBP");
        with_exif.extend_from_slice(&webp_chunk(b"VP8X", &[0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        with_exif.extend_from_slice(&webp_chunk(b"ANIM", &[0; 6]));
        with_exif
            .extend_from_slice(&webp_chunk(b"EXIF", &exif_orientation_payload(6)));
        let riff_len = (with_exif.len() - 8) as u32;
        with_exif[4..8].copy_from_slice(&riff_len.to_le_bytes());
        assert!(animated_webp_uses_exif_orientation(&with_exif));

        // And the public API refuses it rather than changing its appearance.
        let refused = sanitize_image_for_upload(with_exif, "image/webp");
        assert!(refused.is_err());
    }

    #[test]
    fn detects_non_identity_animated_png_exif_orientation() {
        let mut body = animated_png(false);
        // Splice an eXIf chunk with orientation 6 before IEND.
        let mut infected = body.clone();
        infected.truncate(infected.len() - 12); // drop IEND chunk
        infected.extend_from_slice(&png_chunk(b"eXIf", &exif_orientation_payload(6)));
        infected.extend_from_slice(&png_chunk(b"IEND", &[]));
        body = infected;
        assert!(animated_png_uses_exif_orientation(&body));

        let refused = sanitize_image_for_upload(body, "image/png");
        assert!(refused.is_err());
    }

    #[test]
    fn detects_animated_icc_profiles() {
        let mut png = animated_png(false);
        let mut with_iccp = png.clone();
        let iend_at = with_iccp.len() - 12;
        with_iccp.truncate(iend_at);
        with_iccp.extend_from_slice(&png_chunk(b"iCCP", b"profile"));
        with_iccp.extend_from_slice(&png_chunk(b"IEND", &[]));
        png = with_iccp;
        assert!(animated_png_uses_icc_profile(&png));

        let mut with_iccp_webp = b"RIFF".to_vec();
        with_iccp_webp.extend_from_slice(&[0, 0, 0, 0]);
        with_iccp_webp.extend_from_slice(b"WEBP");
        with_iccp_webp
            .extend_from_slice(&webp_chunk(b"VP8X", &[0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        with_iccp_webp.extend_from_slice(&webp_chunk(b"ANIM", &[0; 6]));
        with_iccp_webp.extend_from_slice(&webp_chunk(b"ICCP", b"profile"));
        let riff_len = (with_iccp_webp.len() - 8) as u32;
        with_iccp_webp[4..8].copy_from_slice(&riff_len.to_le_bytes());
        assert!(animated_webp_uses_icc_profile(&with_iccp_webp));
    }

    #[test]
    fn gif_comment_extensions_are_stripped_and_looping_kept() {
        let mut body = b"GIF89a".to_vec();
        // Logical screen descriptor: 2x2 canvas, GCT present (packed 0x80,
        // size 0 → 6-byte table), bg 0, aspect 0.
        body.extend_from_slice(&[0x02, 0x00, 0x02, 0x00, 0x80, 0x00, 0x00]);
        body.extend_from_slice(&[0u8; 6]); // 2-entry GCT (3 * 2^1)
        // Comment extension — metadata, must be dropped.
        body.extend_from_slice(&[0x21, 0xfe, 3, b'a', b'b', b'c', 0]);
        // NETSCAPE looping extension — must be kept.
        body.extend_from_slice(&[
            0x21, 0xff, 11, b'N', b'E', b'T', b'S', b'C', b'A', b'P', b'E', b'2', b'.', b'0', 3, 1,
            0, 0, 0,
        ]);
        body.push(0x3b); // trailer
        let clean = strip_gif_metadata(&body).expect("must parse");
        assert!(!clean.windows(2).any(|w| w == [0x21, 0xfe]));
        assert!(clean.windows(11).any(|w| w == *b"NETSCAPE2.0"));
        assert_eq!(*clean.last().unwrap(), 0x3b);
    }

    #[test]
    fn animated_sanitizers_truncate_trailing_bytes() {
        let mut dirty = animated_png(true);
        dirty.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        let clean = strip_animated_png_metadata(&dirty).expect("must parse");
        // Metadata chunk dropped AND trailing bytes truncated — the result is
        // exactly the clean-input length.
        assert_eq!(clean.len(), animated_png(false).len());
        assert!(!clean.ends_with(&[0xde, 0xad, 0xbe, 0xef]));
    }

    #[test]
    fn non_image_mime_passes_through_unchanged() {
        let bytes = vec![1, 2, 3, 4];
        let out = sanitize_image_for_upload(bytes.clone(), "application/pdf").unwrap();
        assert_eq!(bytes, out);
    }
}

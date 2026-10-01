//! MP3 (`audio/mpeg`) structure: tag stripping for clients, and the relay's
//! metadata-free validator.
//!
//! Same contract as images (`sanitize.rs` / `validation.rs`): the relay stores
//! exactly the bytes it receives (the blob is content-addressed by sha256),
//! so the CLIENT strips metadata before hashing, and the relay rejects any
//! payload that still carries a tag with [`MediaError::MetadataForbidden`].
//!
//! MP3 metadata lives outside the audio stream, in tag blocks glued to either
//! end of it:
//!
//! - **ID3v2** at the head (`"ID3"`, synchsafe size, optional 10-byte footer),
//!   possibly repeated, or appended at the tail with a `"3DI"` footer. This is
//!   where titles, artist, comments, cover art, GEOB blobs, and private
//!   frames — including encoder location/user tags — live.
//! - **ID3v1** (`"TAG"`, the last 128 bytes) and Enhanced ID3v1 (`"TAG+"`,
//!   227 bytes immediately before it).
//! - **APEv2** (`"APETAGEX"` 32-byte footer, optional 32-byte header).
//! - **Lyrics3v2** (`"LYRICS200"` end marker, before ID3v1).
//!
//! After the tags come off, what remains must be a walk of valid MPEG audio
//! frames from byte 0 — an allowlist, like the WAV validator's chunk walk,
//! rather than an enumeration of tag formats. Anything that is not a frame at
//! a frame boundary is rejected, and a structurally plausible ID3v2 header
//! anywhere in the stream (one smuggled inside a frame payload) is rejected
//! as metadata. Free-format bitstreams (bitrate index 0) are rejected: their
//! frame length cannot be derived from the header, so they cannot be walked.

use crate::error::MediaError;

const ID3V2_HEADER_LEN: usize = 10;
const ID3V1_LEN: usize = 128;
const ID3V1_ENHANCED_LEN: usize = 227;
const APE_FOOTER_LEN: usize = 32;
const LYRICS3_END: &[u8] = b"LYRICS200";
/// Lyrics3v2: `LYRICSBEGIN` … 6 ASCII-digit size … `LYRICS200`.
const LYRICS3_SIZE_DIGITS: usize = 6;

/// A parsed MPEG audio frame header (the fields needed to walk the stream).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FrameHeader {
    /// Total frame length in bytes, header included.
    len: usize,
}

/// Parse the 4-byte MPEG audio frame header at the start of `bytes`.
///
/// Returns `None` for anything that is not a walkable frame: missing 11-bit
/// sync (`0xFFE` mask), reserved version/layer/sample-rate/emphasis values,
/// the invalid bitrate index 15, or free-format bitrate (index 0).
fn parse_frame_header(bytes: &[u8]) -> Option<FrameHeader> {
    let [b0, b1, b2, b3] = *bytes.get(..4)? else {
        return None;
    };
    if b0 != 0xFF || (b1 & 0xE0) != 0xE0 {
        return None;
    }
    // Version: 0 = MPEG 2.5, 1 = reserved, 2 = MPEG 2, 3 = MPEG 1.
    let version = (b1 >> 3) & 0x03;
    // Layer: 0 = reserved (also what AAC ADTS carries), 1 = III, 2 = II, 3 = I.
    let layer = (b1 >> 1) & 0x03;
    let bitrate_index = usize::from(b2 >> 4);
    let rate_index = usize::from((b2 >> 2) & 0x03);
    let padding = usize::from((b2 >> 1) & 0x01);
    let emphasis = b3 & 0x03;
    if version == 1 || layer == 0 || bitrate_index == 0 || bitrate_index == 15 {
        return None;
    }
    if rate_index == 3 || emphasis == 2 {
        return None;
    }

    const V1_L1: [u32; 15] = [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
    ];
    const V1_L2: [u32; 15] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
    ];
    const V1_L3: [u32; 15] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    const V2_L1: [u32; 15] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
    ];
    const V2_L23: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

    let mpeg1 = version == 3;
    let kbps = match (mpeg1, layer) {
        (true, 3) => V1_L1[bitrate_index],
        (true, 2) => V1_L2[bitrate_index],
        (true, _) => V1_L3[bitrate_index],
        (false, 3) => V2_L1[bitrate_index],
        (false, _) => V2_L23[bitrate_index],
    };
    let sample_rate: u32 = match version {
        3 => [44_100, 48_000, 32_000][rate_index],
        2 => [22_050, 24_000, 16_000][rate_index],
        _ => [11_025, 12_000, 8_000][rate_index],
    };
    let bitrate = kbps * 1000;
    let len = match layer {
        // Layer I: 4-byte slots.
        3 => ((12 * bitrate / sample_rate) as usize + padding) * 4,
        // Layer II (all versions) and MPEG-1 Layer III: 1152 samples/frame.
        2 => (144 * bitrate / sample_rate) as usize + padding,
        _ if mpeg1 => (144 * bitrate / sample_rate) as usize + padding,
        // MPEG-2/2.5 Layer III: 576 samples/frame.
        _ => (72 * bitrate / sample_rate) as usize + padding,
    };
    (len >= 4).then_some(FrameHeader { len })
}

/// Whether `bytes` opens with MPEG audio frames — a valid header at byte 0
/// and, when the buffer is long enough to hold it, a second valid header
/// exactly one frame later. The second header is what keeps a random binary
/// that happens to start with `0xFFE…` from being sniffed as audio.
///
/// `infer` only recognizes MP3 by a leading `ID3` or the single sync pattern
/// `FF FB`; a tag-stripped MP3 that opens with a CRC-protected or MPEG-2
/// frame (`FF FA`, `FF F3`, `FF E3`, …) needs this sniff to be recognized.
pub fn looks_like_mpeg_audio(bytes: &[u8]) -> bool {
    let Some(first) = parse_frame_header(bytes) else {
        return false;
    };
    match bytes.get(first.len..) {
        Some(rest) if rest.len() >= 4 => parse_frame_header(rest).is_some(),
        // A single (possibly truncated) frame: nothing further to confirm.
        _ => true,
    }
}

/// Whether `bytes` contains a structurally plausible ID3v2 header anywhere:
/// `"ID3"` + major version 2–4 + revision != 0xFF + four synchsafe size bytes
/// (each < 0x80). The structure check keeps the false-positive rate on real
/// audio payload bytes negligible (≈4·10⁻¹¹ per byte offset).
fn contains_id3v2_header(bytes: &[u8]) -> bool {
    bytes.windows(ID3V2_HEADER_LEN).any(|w| {
        &w[..3] == b"ID3"
            && (2..=4).contains(&w[3])
            && w[4] != 0xFF
            && w[6..10].iter().all(|b| *b < 0x80)
    })
}

fn synchsafe_u32(bytes: &[u8]) -> Option<usize> {
    let raw: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    if raw.iter().any(|b| *b >= 0x80) {
        return None;
    }
    Some(
        raw.iter()
            .fold(0usize, |acc, b| (acc << 7) | usize::from(*b)),
    )
}

/// Total length of an ID3v2 tag whose 10-byte header starts `bytes`
/// (header + body + optional footer), or `None` if it is not an ID3v2 header.
fn leading_id3v2_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < ID3V2_HEADER_LEN || &bytes[..3] != b"ID3" {
        return None;
    }
    let body = synchsafe_u32(&bytes[6..10])?;
    // Flag 0x10 (v2.4): a 10-byte footer follows the tag body.
    let footer = if bytes[5] & 0x10 != 0 {
        ID3V2_HEADER_LEN
    } else {
        0
    };
    Some(ID3V2_HEADER_LEN + body + footer)
}

/// Length of the trailing metadata block that ends `bytes`, if any. Each call
/// peels exactly one block; callers loop until it returns `None`.
fn trailing_tag_len(bytes: &[u8]) -> Option<usize> {
    let len = bytes.len();
    // ID3v1 ("TAG", 128 bytes), plus the Enhanced "TAG+" block before it.
    if len >= ID3V1_LEN && &bytes[len - ID3V1_LEN..len - ID3V1_LEN + 3] == b"TAG" {
        let enhanced_start = len.checked_sub(ID3V1_LEN + ID3V1_ENHANCED_LEN);
        if let Some(start) = enhanced_start {
            if &bytes[start..start + 4] == b"TAG+" {
                return Some(ID3V1_LEN + ID3V1_ENHANCED_LEN);
            }
        }
        return Some(ID3V1_LEN);
    }
    // APEv2 footer: "APETAGEX", version, size (items + footer), count, flags.
    if len >= APE_FOOTER_LEN
        && &bytes[len - APE_FOOTER_LEN..len - APE_FOOTER_LEN + 8] == b"APETAGEX"
    {
        let footer = &bytes[len - APE_FOOTER_LEN..];
        let size = u32::from_le_bytes(footer[12..16].try_into().ok()?) as usize;
        let flags = u32::from_le_bytes(footer[20..24].try_into().ok()?);
        // Bit 31: the tag also carries a 32-byte header before its items.
        let header = if flags & 0x8000_0000 != 0 {
            APE_FOOTER_LEN
        } else {
            0
        };
        let total = size.checked_add(header)?;
        return (total >= APE_FOOTER_LEN && total <= len).then_some(total);
    }
    // Lyrics3v2: 6-digit ASCII size (of everything from "LYRICSBEGIN"),
    // then "LYRICS200".
    let marker_len = LYRICS3_SIZE_DIGITS + LYRICS3_END.len();
    if len >= marker_len && bytes.ends_with(LYRICS3_END) {
        let digits = &bytes[len - marker_len..len - LYRICS3_END.len()];
        let size: usize = std::str::from_utf8(digits).ok()?.parse().ok()?;
        let total = size.checked_add(marker_len)?;
        return (total <= len).then_some(total);
    }
    // ID3v2.4 appended at the tail: a "3DI" footer mirrors the header.
    if len >= ID3V2_HEADER_LEN && &bytes[len - ID3V2_HEADER_LEN..len - 7] == b"3DI" {
        let body = synchsafe_u32(&bytes[len - 4..])?;
        let total = body.checked_add(2 * ID3V2_HEADER_LEN)?;
        return (total <= len).then_some(total);
    }
    None
}

/// Where a walk over MPEG frames from byte 0 stopped.
struct FrameWalk {
    /// End offset of the last COMPLETE frame (`0` if there is none).
    end: usize,
    /// The bytes at `end` open a frame header whose declared length runs
    /// past the buffer — an incomplete final frame. Bytes inside that span
    /// are not audio we can vouch for (they can hide metadata).
    truncated: bool,
}

/// Walk MPEG frames from byte 0. `Err` when there is no frame header at
/// byte 0 at all. Otherwise reports the end of the last complete frame and
/// whether an incomplete final frame follows it; any other stop means the
/// bytes at `end` are not a frame header.
fn walk_frames(bytes: &[u8]) -> Result<FrameWalk, MediaError> {
    if parse_frame_header(bytes).is_none() {
        return Err(MediaError::InvalidAudio);
    }
    let mut offset = 0usize;
    while offset < bytes.len() {
        let Some(frame) = parse_frame_header(&bytes[offset..]) else {
            break;
        };
        if frame.len > bytes.len() - offset {
            return Ok(FrameWalk {
                end: offset,
                truncated: true,
            });
        }
        offset += frame.len;
    }
    Ok(FrameWalk {
        end: offset,
        truncated: false,
    })
}

/// Validate that an `audio/mpeg` payload is metadata-free: no ID3v2 / ID3v1 /
/// APEv2 / Lyrics3 tag at either end, no ID3v2 header anywhere inside, and
/// complete MPEG audio frames end to end from byte 0 (an incomplete final
/// frame is rejected).
///
/// This is the relay's check on the generic upload path. It never modifies
/// bytes — the stored blob is exactly what the client hashed.
pub fn validate_mp3(bytes: &[u8]) -> Result<(), MediaError> {
    if leading_id3v2_len(bytes).is_some() || bytes.starts_with(b"ID3") {
        return Err(MediaError::MetadataForbidden);
    }
    if trailing_tag_len(bytes).is_some() {
        return Err(MediaError::MetadataForbidden);
    }
    if contains_id3v2_header(bytes) {
        return Err(MediaError::MetadataForbidden);
    }
    let walk = walk_frames(bytes)?;
    if walk.end != bytes.len() {
        return Err(MediaError::InvalidAudio);
    }
    Ok(())
}

/// Strip every MP3 tag block a client can remove without touching the audio:
/// leading ID3v2 tags (repeated, footer-aware), trailing ID3v1 / Enhanced
/// ID3v1 / APEv2 / Lyrics3v2 / appended ID3v2, an incomplete final frame
/// (cut back to the end of the last complete frame), and trailing zero
/// padding after the last frame. The result is then held to [`validate_mp3`].
///
/// Errors (as a human-readable string, like the image sanitizer) when the
/// payload is not an MP3 stream once the tags are off, or when metadata is
/// embedded where it cannot be removed without altering the audio — an ID3v2
/// header inside the stream, or non-frame bytes between frames.
pub fn strip_mp3_tags(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut start = 0usize;
    while let Some(tag_len) = leading_id3v2_len(&body[start..]) {
        start = start
            .checked_add(tag_len)
            .filter(|end| *end <= body.len())
            .ok_or("mp3: ID3v2 tag size exceeds the file")?;
    }
    let mut end = body.len();
    while let Some(tag_len) = trailing_tag_len(&body[start..end]) {
        end -= tag_len;
    }
    let audio = &body[start..end];

    if contains_id3v2_header(audio) {
        return Err(
            "mp3: an ID3 tag is embedded inside the audio stream; it cannot be stripped safely"
                .to_string(),
        );
    }
    let no_frame = || "mp3: no MPEG audio frame after removing tags (not an MP3 stream)";
    let walk = walk_frames(audio).map_err(|_| no_frame().to_string())?;
    let stop = walk.end;
    if stop == 0 {
        return Err(no_frame().to_string());
    }
    // An incomplete final frame is dropped whole, along with anything hidden
    // inside its declared length. Otherwise zero padding after the last frame
    // carries nothing and is dropped too; any other non-frame bytes are an
    // unknown channel we refuse to guess about.
    let tail = &audio[stop..];
    if !walk.truncated && !tail.iter().all(|b| *b == 0) {
        return Err(format!(
            "mp3: {} unrecognized bytes after the audio frames at offset {}",
            tail.len(),
            start + stop
        ));
    }
    let clean = audio[..stop].to_vec();
    validate_mp3(&clean).map_err(|e| format!("mp3: {e}"))?;
    Ok(clean)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding → 417-byte frames.
    pub(crate) const FRAME_HDR: [u8; 4] = [0xFF, 0xFB, 0x90, 0x00];
    const FRAME_LEN: usize = 417;

    /// `n` back-to-back frames whose payload bytes are a non-repeating
    /// pattern (so no accidental sync words or tag magic appear inside).
    pub(crate) fn clean_mp3(n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n * FRAME_LEN);
        for i in 0..n {
            out.extend_from_slice(&FRAME_HDR);
            out.extend((0..FRAME_LEN - 4).map(|j| ((i * 7 + j) % 0x7F) as u8));
        }
        out
    }

    fn id3v2(body_len: usize, footer: bool) -> Vec<u8> {
        let size = body_len as u32;
        let synchsafe = [
            ((size >> 21) & 0x7F) as u8,
            ((size >> 14) & 0x7F) as u8,
            ((size >> 7) & 0x7F) as u8,
            (size & 0x7F) as u8,
        ];
        let mut tag = vec![b'I', b'D', b'3', 4, 0, if footer { 0x10 } else { 0 }];
        tag.extend_from_slice(&synchsafe);
        // "TIT2" frame-ish payload carrying something identifying.
        let mut body = b"TPE1\0\0\0\x09\0\0\x03Sam G".to_vec();
        body.resize(body_len, 0);
        tag.extend_from_slice(&body);
        if footer {
            tag.extend_from_slice(b"3DI");
            tag.extend_from_slice(&[4, 0, 0x10]);
            tag.extend_from_slice(&synchsafe);
        }
        tag
    }

    fn id3v1() -> Vec<u8> {
        let mut tag = b"TAGSecret Title".to_vec();
        tag.resize(ID3V1_LEN, b' ');
        tag
    }

    fn ape_tag() -> Vec<u8> {
        let items = b"\x05\0\0\0\0\0\0\0Title\0hello";
        let size = (items.len() + APE_FOOTER_LEN) as u32;
        let mut tag = Vec::new();
        let mut header = b"APETAGEX".to_vec();
        header.extend_from_slice(&2000u32.to_le_bytes());
        header.extend_from_slice(&size.to_le_bytes());
        header.extend_from_slice(&1u32.to_le_bytes());
        header.extend_from_slice(&0xA000_0000u32.to_le_bytes()); // has header, is header
        header.extend_from_slice(&[0; 8]);
        tag.extend_from_slice(&header);
        tag.extend_from_slice(items);
        let mut footer = b"APETAGEX".to_vec();
        footer.extend_from_slice(&2000u32.to_le_bytes());
        footer.extend_from_slice(&size.to_le_bytes());
        footer.extend_from_slice(&1u32.to_le_bytes());
        footer.extend_from_slice(&0x8000_0000u32.to_le_bytes()); // has header
        footer.extend_from_slice(&[0; 8]);
        tag.extend_from_slice(&footer);
        tag
    }

    #[test]
    fn frame_header_lengths_match_the_spec_formulas() {
        assert_eq!(parse_frame_header(&FRAME_HDR).map(|h| h.len), Some(417));
        // Same with padding bit → 418.
        assert_eq!(
            parse_frame_header(&[0xFF, 0xFB, 0x92, 0x00]).map(|h| h.len),
            Some(418)
        );
        // MPEG-2 Layer III, 64 kbps, 22.05 kHz → 72*64000/22050 = 208.
        assert_eq!(
            parse_frame_header(&[0xFF, 0xF3, 0x80, 0x00]).map(|h| h.len),
            Some(208)
        );
        // Free-format, bitrate 15, reserved version/layer/rate/emphasis.
        for bad in [
            [0xFF, 0xFB, 0x00, 0x00],
            [0xFF, 0xFB, 0xF0, 0x00],
            [0xFF, 0xEB, 0x90, 0x00],
            [0xFF, 0xF9, 0x90, 0x00], // layer 0 — AAC ADTS
            [0xFF, 0xFB, 0x9C, 0x00],
            [0xFF, 0xFB, 0x90, 0x02],
            [0xFF, 0x1B, 0x90, 0x00],
        ] {
            assert_eq!(parse_frame_header(&bad), None, "{bad:02X?}");
        }
    }

    #[test]
    fn clean_mp3_is_accepted_unchanged() {
        let clean = clean_mp3(5);
        assert_eq!(validate_mp3(&clean).ok(), Some(()));
        assert_eq!(strip_mp3_tags(&clean).as_deref(), Ok(clean.as_slice()));
    }

    #[test]
    fn truncated_final_frame_is_rejected_and_stripped() {
        let clean = clean_mp3(3);
        let mut truncated = clean.clone();
        truncated.extend_from_slice(&clean_mp3(1)[..FRAME_LEN - 100]);
        assert!(matches!(
            validate_mp3(&truncated),
            Err(MediaError::InvalidAudio)
        ));
        assert_eq!(strip_mp3_tags(&truncated).unwrap(), clean);
    }

    #[test]
    fn metadata_inside_a_truncated_final_frame_does_not_survive() {
        // A frame header whose declared 417 bytes run past EOF, with a
        // Lyrics3v1 block (not a recognized trailing tag) inside that span.
        let clean = clean_mp3(3);
        let mut smuggled = clean.clone();
        smuggled.extend_from_slice(&FRAME_HDR);
        smuggled.extend_from_slice(&[0x11; 20]);
        smuggled.extend_from_slice(b"LYRICSBEGININDsecretLYRICSEND");
        assert!(smuggled.len() < clean.len() + FRAME_LEN);
        assert!(matches!(
            validate_mp3(&smuggled),
            Err(MediaError::InvalidAudio)
        ));
        let out = strip_mp3_tags(&smuggled).unwrap();
        assert_eq!(out, clean);
        assert!(!out.windows(6).any(|w| w == b"secret"));
    }

    #[test]
    fn blob_shorter_than_one_frame_is_not_mp3() {
        let mut lone = FRAME_HDR.to_vec();
        lone.extend_from_slice(&[0x11; 100]);
        assert!(matches!(validate_mp3(&lone), Err(MediaError::InvalidAudio)));
        assert!(strip_mp3_tags(&lone)
            .unwrap_err()
            .contains("no MPEG audio frame"));
    }

    #[test]
    fn leading_id3v2_is_stripped_and_rejected_by_validator() {
        let clean = clean_mp3(4);
        let mut tagged = id3v2(300, false);
        tagged.extend_from_slice(&clean);
        assert!(matches!(
            validate_mp3(&tagged),
            Err(MediaError::MetadataForbidden)
        ));
        assert_eq!(strip_mp3_tags(&tagged).unwrap(), clean);
    }

    #[test]
    fn repeated_and_footer_flagged_id3v2_are_all_stripped() {
        let clean = clean_mp3(4);
        let mut tagged = id3v2(64, true);
        tagged.extend_from_slice(&id3v2(32, false));
        tagged.extend_from_slice(&clean);
        assert_eq!(strip_mp3_tags(&tagged).unwrap(), clean);
    }

    #[test]
    fn trailing_id3v1_enhanced_ape_and_lyrics_are_stripped() {
        let clean = clean_mp3(4);
        let mut enhanced = b"TAG+".to_vec();
        enhanced.resize(ID3V1_ENHANCED_LEN, b'x');
        let mut lyrics = b"LYRICSBEGININD00002".to_vec();
        let size = lyrics.len();
        lyrics.extend_from_slice(format!("{size:06}").as_bytes());
        lyrics.extend_from_slice(LYRICS3_END);

        let mut tagged = clean.clone();
        tagged.extend_from_slice(&ape_tag());
        tagged.extend_from_slice(&lyrics);
        tagged.extend_from_slice(&enhanced);
        tagged.extend_from_slice(&id3v1());
        assert!(matches!(
            validate_mp3(&tagged),
            Err(MediaError::MetadataForbidden)
        ));
        assert_eq!(strip_mp3_tags(&tagged).unwrap(), clean);
    }

    #[test]
    fn validator_rejects_each_trailing_tag_kind() {
        let clean = clean_mp3(3);
        for (name, tag) in [
            ("id3v1", id3v1()),
            ("ape", ape_tag()),
            ("id3v2-tail", id3v2(20, true)),
        ] {
            let mut tagged = clean.clone();
            tagged.extend_from_slice(&tag);
            assert!(
                matches!(validate_mp3(&tagged), Err(MediaError::MetadataForbidden)),
                "{name} survived validation"
            );
            assert_eq!(strip_mp3_tags(&tagged).unwrap(), clean, "{name}");
        }
    }

    #[test]
    fn id3_inside_the_stream_is_rejected_by_both() {
        let mut body = clean_mp3(2);
        body.extend_from_slice(&id3v2(40, false));
        body.extend_from_slice(&clean_mp3(2));
        assert!(matches!(
            validate_mp3(&body),
            Err(MediaError::MetadataForbidden)
        ));
        assert!(strip_mp3_tags(&body).unwrap_err().contains("embedded"));

        // Smuggled inside a frame payload rather than at a boundary.
        let mut inside = clean_mp3(3);
        inside[500..510].copy_from_slice(&id3v2(0, false)[..10]);
        assert!(matches!(
            validate_mp3(&inside),
            Err(MediaError::MetadataForbidden)
        ));
        assert!(strip_mp3_tags(&inside).is_err());
    }

    #[test]
    fn garbage_is_rejected() {
        let garbage: Vec<u8> = (0..4096).map(|i| (i * 31 % 251) as u8).collect();
        assert!(matches!(
            validate_mp3(&garbage),
            Err(MediaError::InvalidAudio)
        ));
        assert!(strip_mp3_tags(&garbage).is_err());
        // An ID3 tag followed by garbage: strippable tag, but no audio.
        let mut tagged_garbage = id3v2(16, false);
        tagged_garbage.extend_from_slice(&garbage);
        assert!(strip_mp3_tags(&tagged_garbage)
            .unwrap_err()
            .contains("no MPEG audio frame"));
        assert!(!looks_like_mpeg_audio(&garbage));
        assert!(strip_mp3_tags(&[]).is_err());
    }

    #[test]
    fn junk_between_frames_is_rejected_but_zero_padding_is_trimmed() {
        let clean = clean_mp3(3);
        let mut junk = clean.clone();
        junk.extend_from_slice(b"hidden channel");
        assert!(matches!(validate_mp3(&junk), Err(MediaError::InvalidAudio)));
        assert!(strip_mp3_tags(&junk).is_err());

        // Frame-aligned zero padding: the walk stops on a non-header.
        let mut padded = clean.clone();
        padded.extend_from_slice(&[0u8; 64]);
        assert_eq!(strip_mp3_tags(&padded).unwrap(), clean);
    }

    #[test]
    fn sniff_needs_a_second_frame_header() {
        assert!(looks_like_mpeg_audio(&clean_mp3(2)));
        // MPEG-2 frames (`FF F3`) that `infer` does not recognize.
        let mut v2 = Vec::new();
        for _ in 0..2 {
            v2.extend_from_slice(&[0xFF, 0xF3, 0x80, 0x00]);
            v2.extend(std::iter::repeat_n(0x11u8, 204));
        }
        assert!(looks_like_mpeg_audio(&v2));
        assert!(validate_mp3(&v2).is_ok());
        // Valid first header, junk where the second should be.
        let mut lone = FRAME_HDR.to_vec();
        lone.extend(std::iter::repeat_n(0x11u8, 800));
        assert!(!looks_like_mpeg_audio(&lone));
    }
}

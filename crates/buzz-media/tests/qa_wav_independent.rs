//! Independent QA adversarial vectors for the voice-reference WAV allowance
//! (design docs/plans/2026-09-15-voice-repository-v1.md §4, §9).
//!
//! Every byte sequence here is constructed from the RIFF spec by hand — no
//! reuse of the crate's own test fixtures — so a fixture bug cannot mask a
//! validator bug. Added by the QA pass for Voice Repository v1.

use buzz_media::config::MediaConfig;
use buzz_media::validation::{validate_file_content, validate_voice_reference_wav};

fn le16(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

fn le32(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

fn chunk(id: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(id);
    out.extend_from_slice(&le32(payload.len() as u32));
    out.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        out.push(0); // word-alignment pad
    }
    out
}

/// 16-byte canonical PCM fmt chunk.
fn fmt_pcm(channels: u16, sample_rate: u32, bits: u16) -> Vec<u8> {
    let block_align = channels * (bits / 8);
    let byte_rate = sample_rate * block_align as u32;
    let mut f = Vec::with_capacity(16);
    f.extend_from_slice(&le16(1)); // PCM
    f.extend_from_slice(&le16(channels));
    f.extend_from_slice(&le32(sample_rate));
    f.extend_from_slice(&le32(byte_rate));
    f.extend_from_slice(&le16(block_align));
    f.extend_from_slice(&le16(bits));
    f
}

fn fmt_float(channels: u16, sample_rate: u32) -> Vec<u8> {
    let block_align = channels * 4;
    let byte_rate = sample_rate * block_align as u32;
    let mut f = Vec::with_capacity(16);
    f.extend_from_slice(&le16(3)); // IEEE float
    f.extend_from_slice(&le16(channels));
    f.extend_from_slice(&le32(sample_rate));
    f.extend_from_slice(&le32(byte_rate));
    f.extend_from_slice(&le16(block_align));
    f.extend_from_slice(&le16(32));
    f
}

fn riff(inner: &[Vec<u8>]) -> Vec<u8> {
    // Declared size covers everything after the size field: "WAVE" + chunks.
    let body: usize = 4 + inner.iter().map(|c| c.len()).sum::<usize>();
    let mut out = Vec::with_capacity(8 + body);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&le32(body as u32));
    out.extend_from_slice(b"WAVE");
    for c in inner {
        out.extend_from_slice(c);
    }
    out
}

fn config() -> MediaConfig {
    MediaConfig {
        s3_endpoint: "http://localhost:9000".into(),
        s3_access_key: "qa".into(),
        s3_secret_key: "qa".into(),
        s3_bucket: "qa".into(),
        s3_region: "us-east-1".into(),
        s3_addressing_style: Default::default(),
        max_image_bytes: 50_000_000,
        max_gif_bytes: 10_000_000,
        max_video_bytes: 500_000_000,
        max_file_bytes: 100_000_000,
        public_base_url: "http://localhost:9000/media".into(),
        upload_records_enabled: false,
        upload_ip_header: None,
        upload_port_header: None,
    }
}

#[test]
fn qa_minimal_valid_pcm_wav_passes_both_gates() {
    let wav = riff(&[
        chunk(b"fmt ", &fmt_pcm(1, 32_000, 16)),
        chunk(b"data", &[0u8; 4]), // 2 frames of mono 16-bit
    ]);
    assert!(
        validate_voice_reference_wav(&wav).is_ok(),
        "minimal canonical PCM WAV must pass the structural validator"
    );
    let (mime, ext) = validate_file_content(&wav, &config())
        .expect("minimal canonical PCM WAV must pass the wired file path");
    assert_eq!(mime, "audio/wav");
    assert_eq!(ext, "wav");
}

#[test]
fn qa_stereo_pcm_and_mono_float_pass() {
    let stereo = riff(&[
        chunk(b"fmt ", &fmt_pcm(2, 44_100, 16)),
        chunk(b"data", &[0u8; 8]),
    ]);
    assert!(validate_voice_reference_wav(&stereo).is_ok());
    let float = riff(&[
        chunk(b"fmt ", &fmt_float(1, 32_000)),
        chunk(b"data", &[0u8; 8]),
    ]);
    assert!(validate_voice_reference_wav(&float).is_ok());
}

#[test]
fn qa_list_info_chunk_is_rejected_by_both_gates() {
    let info = b"INFOISFT".to_vec(); // a metadata sub-block inside LIST
    let mut inner = vec![
        chunk(b"fmt ", &fmt_pcm(1, 32_000, 16)),
        chunk(b"LIST", &info),
        chunk(b"data", &[0u8; 4]),
    ];
    let wav = riff(&inner);
    assert!(
        validate_voice_reference_wav(&wav).is_err(),
        "a LIST/INFO metadata chunk must be rejected"
    );
    assert!(validate_file_content(&wav, &config()).is_err());

    // ID3 chunk, too.
    inner[1] = chunk(b"ID3 ", b"\x03\x00fake");
    let wav = riff(&inner);
    assert!(validate_voice_reference_wav(&wav).is_err());
}

#[test]
fn qa_lying_data_chunk_size_is_rejected() {
    // data declares 8 bytes but only 4 follow: chunk end runs past the file.
    let mut wav = riff(&[chunk(b"fmt ", &fmt_pcm(1, 32_000, 16)), chunk(b"data", &[0u8; 4])]);
    // Layout: RIFF hdr 12 bytes, fmt chunk 24 bytes (8 hdr + 16 payload),
    // then the data chunk header — its size field lives at offset 12+24+4.
    let data_size_at = 12 + 24 + 4;
    assert_eq!(&wav[data_size_at - 4..data_size_at], b"data");
    wav[data_size_at..data_size_at + 4].copy_from_slice(&le32(8u32));
    assert!(validate_voice_reference_wav(&wav).is_err());
}

#[test]
fn qa_riff_declared_size_shorter_than_file_is_rejected() {
    let mut wav = riff(&[
        chunk(b"fmt ", &fmt_pcm(1, 32_000, 16)),
        chunk(b"data", &[0u8; 4]),
    ]);
    // Append a hidden trailing byte and leave the RIFF size declaring the old length.
    wav.push(0xAA);
    assert!(
        validate_voice_reference_wav(&wav).is_err(),
        "trailing bytes beyond the declared RIFF size are a hidden channel"
    );
}

#[test]
fn qa_truncated_transfer_is_rejected() {
    let wav = riff(&[
        chunk(b"fmt ", &fmt_pcm(1, 32_000, 16)),
        chunk(b"data", &[0u8; 4096]),
    ]);
    let truncated = &wav[..wav.len() / 2];
    assert!(validate_voice_reference_wav(truncated).is_err());
}

#[test]
fn qa_second_data_chunk_is_rejected() {
    let wav = riff(&[
        chunk(b"fmt ", &fmt_pcm(1, 32_000, 16)),
        chunk(b"data", &[0u8; 4]),
        chunk(b"data", &[0u8; 4]),
    ]);
    assert!(validate_voice_reference_wav(&wav).is_err());
}

#[test]
fn qa_mp3_still_rejected_through_the_file_path() {
    let mp3 = b"ID3\x04\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x44rest-of-frame".to_vec();
    let err = validate_file_content(&mp3, &config());
    assert!(err.is_err(), "mp3 must stay rejected on the generic path");
}

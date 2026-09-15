//! Shared table of bundled Pocket voice presets — the single source both the
//! desktop registry and the `buzz voices publish-bundled` CLI command read.
//!
//! Stable keys identify audio, not display labels. The values are transcribed
//! from the desktop's `desktop/src-tauri/src/huddle/tts_voice_registry.rs`
//! table (which pins the bundled WAV bytes and its own copy of the revision);
//! a desktop drift-guard test asserts the two tables agree on keys and
//! hashes, so a value change on either side fails a test instead of silently
//! forking the catalog.
//!
//! `pocket:eve` is deliberately IN the bundled table (it is a stock preset
//! desktops ship) but OUT of the publishable set: the identity-test ban
//! forbids catalog publication of that key (design
//! `docs/plans/2026-09-15-voice-repository-v1.md` §3.3 rule 1).

/// Pinned upstream Kyutai `tts-voices` revision the VCTK reference files are
/// read from. Must match the desktop's `VCTK_REVISION`; the desktop
/// drift-guard test compares the two.
pub const VCTK_REVISION: &str = "323332d33f997de8394f24a193e1a76df720e01a";

/// The one voice key refused at catalog publication (identity-test ban). Local
/// use is unaffected — only `buzz voices` refuses to publish it.
pub const EVE_VOICE_KEY: &str = "pocket:eve";

/// One bundled Pocket preset: stable key, editable label, upstream VCTK file,
/// and the pinned sha256 of the reference WAV.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundledVoicePreset {
    /// Stable identity, `pocket:<slug>`.
    pub key: &'static str,
    /// Human label as published by Kyutai.
    pub display_name: &'static str,
    /// File name within the VCTK set (e.g. `p228_023_enhanced.wav`).
    pub upstream_vctk_file: &'static str,
    /// sha256 of the reference WAV, 64 lowercase hex.
    pub sha256: &'static str,
}

/// Official English Pocket presets, in the order published by Kyutai.
pub const POCKET_PRESETS: [BundledVoicePreset; 12] = [
    BundledVoicePreset {
        key: "pocket:anna",
        display_name: "Anna",
        upstream_vctk_file: "p228_023_enhanced.wav",
        sha256: "0a6de25cf12bf1540beb85979f306a92be81fecc051c547c5395e7e5237a3856",
    },
    BundledVoicePreset {
        key: "pocket:vera",
        display_name: "Vera",
        upstream_vctk_file: "p229_023_enhanced.wav",
        sha256: "309cf91a895830f15842b398f69a4962cb1f7e0bfab10e25dd27838e826c204b",
    },
    BundledVoicePreset {
        key: "pocket:fantine",
        display_name: "Fantine",
        upstream_vctk_file: "p244_023_enhanced.wav",
        sha256: "5f07d4e2a3f20a15572aae885156b43ef3fc12ef3812996fd135680d9956448b",
    },
    BundledVoicePreset {
        key: "pocket:charles",
        display_name: "Charles",
        upstream_vctk_file: "p254_023_enhanced.wav",
        sha256: "6b681a429198f16e378d53bccb08d06939da7b00144a7696111d4f8f76be7756",
    },
    BundledVoicePreset {
        key: "pocket:paul",
        display_name: "Paul",
        upstream_vctk_file: "p259_023_enhanced.wav",
        sha256: "7aba504fe0b3b16478b69eb27ce6007e3cb42b0c1915b5f1c6a6024ae37d679b",
    },
    BundledVoicePreset {
        key: "pocket:eponine",
        display_name: "Eponine",
        upstream_vctk_file: "p262_023_enhanced.wav",
        sha256: "a13c27fb47627b05223691a0ef2974358a18c886e6c2f9d2762ff1d02c20926b",
    },
    BundledVoicePreset {
        key: "pocket:azelma",
        display_name: "Azelma",
        upstream_vctk_file: "p303_023_enhanced.wav",
        sha256: "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026",
    },
    BundledVoicePreset {
        key: "pocket:george",
        display_name: "George",
        upstream_vctk_file: "p315_023_enhanced.wav",
        sha256: "29a41f93bf5236e5b21501091d7774c255d5f3d4e62fa4f9fdf0a92a793c84ae",
    },
    BundledVoicePreset {
        key: "pocket:mary",
        display_name: "Mary",
        upstream_vctk_file: "p333_023_enhanced.wav",
        sha256: "a35b0468382218e9f37a9a7494d1e4b74deaf18d7ced22265b4e325bb55c183f",
    },
    BundledVoicePreset {
        key: "pocket:jane",
        display_name: "Jane",
        upstream_vctk_file: "p339_023_enhanced.wav",
        sha256: "2f12e7f155eb3118f55425394f1b049e5b1b67bdc9b3932c8ba4521420aeb84a",
    },
    BundledVoicePreset {
        key: "pocket:michael",
        display_name: "Michael",
        upstream_vctk_file: "p360_023_enhanced.wav",
        sha256: "b6743e9195e5e3fd34fe9d1633ae93f7ffab787b249e45f6467d7d6f7a6ee6ad",
    },
    BundledVoicePreset {
        key: "pocket:eve",
        display_name: "Eve",
        upstream_vctk_file: "p361_023_enhanced.wav",
        sha256: "396e7cbd066b0f3fb6d67fa26e7904076958239d736d4390f15b5fe88feb14cd",
    },
];

/// The presets a catalog publication may emit: every bundled preset except the
/// identity-test-banned `pocket:eve`.
pub fn publishable_presets() -> impl Iterator<Item = &'static BundledVoicePreset> {
    POCKET_PRESETS
        .iter()
        .filter(|preset| preset.key != EVE_VOICE_KEY)
}

/// Upstream attribution URL for a preset: the pinned VCTK file in Kyutai's
/// `tts-voices` repository at [`VCTK_REVISION`]. This is the same URL shape
/// the desktop emits for bundled rows.
pub fn source_url(preset: &BundledVoicePreset) -> String {
    format!(
        "https://huggingface.co/kyutai/tts-voices/blob/{VCTK_REVISION}/vctk/{}",
        preset.upstream_vctk_file
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_table_shape() {
        assert_eq!(
            POCKET_PRESETS.len(),
            12,
            "the bundled table must match the desktop's 12 official English presets"
        );
        let mut keys = std::collections::HashSet::new();
        for preset in &POCKET_PRESETS {
            assert!(
                keys.insert(preset.key),
                "duplicate preset key: {}",
                preset.key
            );
            assert!(
                preset.key.starts_with("pocket:") && !preset.display_name.is_empty(),
                "preset {} must be a qualified key with a label",
                preset.key
            );
            assert_eq!(
                preset.sha256.len(),
                64,
                "preset {} hash must be 64 chars",
                preset.key
            );
            assert!(
                preset
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
                "preset {} hash must be lowercase hex",
                preset.key
            );
            assert!(
                preset.upstream_vctk_file.starts_with('p') && preset.upstream_vctk_file.ends_with(".wav"),
                "preset {} upstream file must be a VCTK wav",
                preset.key
            );
        }
    }

    #[test]
    fn publishable_presets_exclude_eve() {
        // Hardcode the expected size and the banned key rather than deriving
        // them, so removing the filter (or adding a second banned key)
        // cannot move the expectation with the code it pins.
        let keys: Vec<&str> = publishable_presets().map(|preset| preset.key).collect();
        assert_eq!(keys.len(), 11, "11 of the 12 presets are publishable");
        assert!(
            !keys.contains(&EVE_VOICE_KEY),
            "pocket:eve must never be publishable (identity-test ban)"
        );
        assert!(
            POCKET_PRESETS.iter().any(|preset| preset.key == EVE_VOICE_KEY),
            "eve stays in the bundled table — only its publication is banned"
        );
    }

    #[test]
    fn source_url_matches_the_desktop_format() {
        let azelma = POCKET_PRESETS
            .iter()
            .find(|preset| preset.key == "pocket:azelma")
            .expect("azelma preset");
        assert_eq!(
            source_url(azelma),
            "https://huggingface.co/kyutai/tts-voices/blob/323332d33f997de8394f24a193e1a76df720e01a/vctk/p303_023_enhanced.wav"
        );
    }
}

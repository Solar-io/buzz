//! `buzz share` — put deliverables on a channel's Shelf (Phase 6).
//!
//! A share is an ordinary kind 9 message (no new kind): one `imeta` per file
//! carrying `filename`, the `["t","shelf"]` marker, and — unless `--no-path` —
//! one `["path","<host>:<abs path>"]` per file. Files go through the relay's
//! generic upload path ([`UploadMode::Any`]); the relay is the validator.
//! The message itself goes through the one `messages send` path (hold gate,
//! mention preflight, session stamp) via [`ShareAttachment`].

use std::path::Path;

use crate::client::{sanitize_share_filename, BlobDescriptor, BuzzClient, UploadMode};
use crate::commands::messages::{send_message, SendMessageParams, ShareAttachment};
use crate::error::CliError;
use crate::ShareArgs;

/// Maximum files per share (one message).
const MAX_SHARE_FILES: usize = 10;

/// Short hostname for the `path` tag: the machine name up to the first `.`,
/// lowercased (`crichton.local` → `crichton`).
fn short_hostname() -> Option<String> {
    let host = whoami::hostname().ok()?;
    let short = host.split('.').next().unwrap_or("").trim().to_lowercase();
    (!short.is_empty()).then_some(short)
}

/// `<host>:<abs path>` for one shared file. The path is made absolute AS
/// GIVEN — symlinks are deliberately not resolved, so sharing through a link
/// never discloses where the link points.
fn path_tag_value(host: &str, path: &Path) -> Result<String, CliError> {
    let abs = std::path::absolute(path)
        .map_err(|e| CliError::Usage(format!("cannot resolve {}: {e}", path.display())))?;
    Ok(format!("{host}:{}", abs.display()))
}

/// The host for `path` tags, or `None` when `--no-path` was passed (or no
/// hostname resolves). `hostname` is injected so the wiring is testable.
fn share_host(args: &ShareArgs, hostname: impl FnOnce() -> Option<String>) -> Option<String> {
    if args.no_path {
        return None;
    }
    let h = hostname();
    if h.is_none() {
        eprintln!("buzz share: hostname unavailable; sending without path tags");
    }
    h
}

/// Reject anything that is not an existing regular file before any upload.
fn check_share_paths(paths: &[String]) -> Result<(), CliError> {
    if paths.is_empty() || paths.len() > MAX_SHARE_FILES {
        return Err(CliError::Usage(format!(
            "buzz share takes 1-{MAX_SHARE_FILES} files, got {}",
            paths.len()
        )));
    }
    for p in paths {
        let meta =
            std::fs::metadata(p).map_err(|e| CliError::Usage(format!("cannot access {p}: {e}")))?;
        if !meta.is_file() {
            return Err(CliError::Usage(format!("{p} is not a regular file")));
        }
    }
    Ok(())
}

/// Build the [`ShareAttachment`] from uploaded blobs, their source paths and
/// the optional host (None = `--no-path`, or no resolvable hostname).
fn build_share_attachment(
    uploaded: Vec<(BlobDescriptor, String)>,
    sources: &[String],
    host: Option<&str>,
) -> Result<ShareAttachment, CliError> {
    let paths = match host {
        Some(h) => sources
            .iter()
            .map(|p| path_tag_value(h, Path::new(p)))
            .collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    Ok(ShareAttachment {
        files: uploaded,
        paths,
    })
}

pub async fn cmd_share(client: &BuzzClient, args: ShareArgs) -> Result<(), CliError> {
    check_share_paths(&args.paths)?;

    let host = share_host(&args, short_hostname);

    let mut uploaded = Vec::with_capacity(args.paths.len());
    for p in &args.paths {
        let filename = sanitize_share_filename(Path::new(p))?;
        let desc = client.upload_file_with(p, UploadMode::Any).await?;
        uploaded.push((desc, filename));
    }
    let files_json: Vec<serde_json::Value> = uploaded
        .iter()
        .map(|(d, name)| {
            serde_json::json!({
                "filename": name,
                "url": d.url,
                "mime": d.mime_type,
                "size": d.size,
                "sha256": d.sha256,
            })
        })
        .collect();

    let share = build_share_attachment(uploaded, &args.paths, host.as_deref())?;
    let mut output = send_message(
        client,
        SendMessageParams {
            channel_id: args.channel,
            content: args.summary.unwrap_or_default(),
            kind: None,
            reply_to: args.reply_to,
            broadcast: false,
            files: Vec::new(),
            mentions: args.mentions,
            supersede: false,
            card: None,
            stage: None,
            share: Some(share),
        },
    )
    .await?;
    if let Some(obj) = output.as_object_mut() {
        obj.insert("files".into(), serde_json::json!(files_json));
    }
    println!("{output}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::messages::attach_share_files;

    fn blob(url: &str, mime: &str) -> BlobDescriptor {
        BlobDescriptor {
            url: url.into(),
            sha256: "ab".repeat(32),
            size: 12,
            mime_type: mime.into(),
            uploaded: 0,
            dim: None,
            blurhash: None,
            thumb: None,
            duration: None,
        }
    }

    /// Build the kind 9 the send path would publish for a share (no session
    /// stamp — that only exists inside a managed session).
    fn share_event_tags(share: ShareAttachment) -> (Vec<Vec<String>>, String) {
        let mut media_tags = Vec::new();
        let mut media_content = String::new();
        let trailing = attach_share_files(Some(share), &mut media_tags, &mut media_content);
        media_tags.extend(trailing);
        let channel = uuid::Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap();
        let content = format!("summary{media_content}");
        let builder =
            buzz_sdk::build_message(channel, &content, None, &[], false, &media_tags).unwrap();
        let event = builder
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign");
        let tags = event
            .tags
            .iter()
            .map(|t| t.as_slice().to_vec())
            .collect::<Vec<_>>();
        (tags, event.content.clone())
    }

    fn two_file_share(paths: Vec<String>) -> ShareAttachment {
        ShareAttachment {
            files: vec![
                (
                    blob("https://r.test/media/aa.bin", "application/octet-stream"),
                    "report.md".into(),
                ),
                (
                    blob("https://r.test/media/bb.png", "image/png"),
                    "chart.png".into(),
                ),
            ],
            paths,
        }
    }

    #[test]
    fn share_event_tags_in_order() {
        let (tags, _) = share_event_tags(two_file_share(vec![
            "crichton:/tmp/report.md".into(),
            "crichton:/tmp/chart.png".into(),
        ]));
        let names: Vec<String> = tags
            .iter()
            .map(|t| match t[0].as_str() {
                "t" => format!("t:{}", t[1]),
                other => other.to_string(),
            })
            .collect();
        assert_eq!(
            names,
            vec!["h", "imeta", "imeta", "t:shelf", "path", "path"]
        );
        assert_eq!(tags[4], vec!["path", "crichton:/tmp/report.md"]);
        assert_eq!(tags[5], vec!["path", "crichton:/tmp/chart.png"]);
        assert_eq!(tags[1].last().unwrap(), "filename report.md");
        assert_eq!(tags[2].last().unwrap(), "filename chart.png");
    }

    #[test]
    fn no_path_flag_omits_path_tags() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("report.md");
        std::fs::write(&f, "# hi").unwrap();
        let sources = vec![f.to_string_lossy().into_owned()];
        let uploaded = vec![(
            blob("https://r.test/media/aa.bin", "application/octet-stream"),
            "report.md".to_string(),
        )];

        // --no-path → host None → no path tags at all.
        let share = build_share_attachment(uploaded.clone(), &sources, None).unwrap();
        let (tags, _) = share_event_tags(share);
        assert!(
            !tags.iter().any(|t| t[0] == "path"),
            "--no-path must emit no path tag: {tags:?}"
        );
        assert!(tags.iter().any(|t| t == &vec!["t", "shelf"]));

        // Default → one `<host>:<canonical abs path>` per file.
        let share = build_share_attachment(uploaded, &sources, Some("crichton")).unwrap();
        let abs = std::path::absolute(&f).unwrap();
        assert_eq!(
            share.paths,
            vec![format!("crichton:{}", abs.display())],
            "default share must carry the path tag"
        );
    }

    fn parse_share(argv: &[&str]) -> ShareArgs {
        #[derive(clap::Parser)]
        struct W {
            #[command(flatten)]
            args: ShareArgs,
        }
        <W as clap::Parser>::try_parse_from(argv)
            .expect("parse")
            .args
    }

    #[test]
    fn no_path_cli_flag_suppresses_host() {
        let host = || Some("crichton".to_string());
        let with = parse_share(&["share", "a.md", "--channel", "c", "--no-path"]);
        assert!(with.no_path, "--no-path must parse");
        assert_eq!(
            share_host(&with, host),
            None,
            "--no-path must drop the host"
        );
        let without = parse_share(&["share", "a.md", "--channel", "c"]);
        assert_eq!(share_host(&without, host), Some("crichton".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn path_tag_does_not_resolve_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("secret-real-dir");
        std::fs::create_dir(&real_dir).unwrap();
        let target = real_dir.join("report.md");
        std::fs::write(&target, "# hi").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let value = path_tag_value("crichton", &link).unwrap();
        assert_eq!(value, format!("crichton:{}", link.display()));
        assert!(
            !value.contains("secret-real-dir"),
            "path tag must not reveal the link target: {value}"
        );
    }

    #[test]
    fn content_links_generic_file_by_filename() {
        let (_, content) = share_event_tags(two_file_share(Vec::new()));
        assert_eq!(
            content,
            "summary\n[report.md](https://r.test/media/aa.bin)\n![image](https://r.test/media/bb.png)"
        );
    }

    #[test]
    fn share_rejects_directories_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy().into_owned();
        assert!(matches!(
            check_share_paths(&[d]),
            Err(CliError::Usage(m)) if m.contains("not a regular file")
        ));
        let missing = dir.path().join("nope.md").to_string_lossy().into_owned();
        assert!(matches!(
            check_share_paths(&[missing]),
            Err(CliError::Usage(_))
        ));
    }
}

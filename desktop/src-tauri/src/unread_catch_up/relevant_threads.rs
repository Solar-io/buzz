use std::collections::{BTreeMap, HashMap, HashSet};

use futures_util::{stream, StreamExt};
use nostr::{Event, Keys};

use super::{
    catch_up_kinds, fetch_filter_pages, AppState, CatchUpChannel, CHANNEL_FETCH_CONCURRENCY,
    ROOT_FILTER_CHUNK,
};

fn relevant_thread_filter(channels: &[CatchUpChannel], roots: &[String]) -> serde_json::Value {
    let since = channels.first().map_or(0, relevant_thread_since);
    debug_assert!(
        channels
            .iter()
            .all(|channel| relevant_thread_since(channel) == since),
        "relevant-thread filters must contain one read frontier"
    );
    let channel_type = if channels.iter().any(|channel| channel.channel_type == "dm") {
        "dm"
    } else {
        "stream"
    };
    let channel_ids = channels
        .iter()
        .map(|channel| channel.id.as_str())
        .collect::<Vec<_>>();
    serde_json::json!({
        "kinds": catch_up_kinds(channel_type),
        "#h": channel_ids,
        "#e": roots,
        "since": since,
        "limit": super::CATCH_UP_LIMIT,
    })
}

fn relevant_thread_since(channel: &CatchUpChannel) -> u64 {
    channel.read_at.map_or(0, |value| value.saturating_add(1))
}

fn channels_by_frontier(channels: &[CatchUpChannel]) -> BTreeMap<u64, Vec<CatchUpChannel>> {
    let mut groups = BTreeMap::<u64, Vec<CatchUpChannel>>::new();
    for channel in channels {
        groups
            .entry(relevant_thread_since(channel))
            .or_default()
            .push(channel.clone());
    }
    groups
}

fn event_channel_id(event: &Event) -> Option<&str> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().is_some_and(|part| part == "h"))
        .and_then(|tag| tag.as_slice().get(1))
        .map(String::as_str)
}

fn bucket_requested_events(
    events: Vec<Event>,
    channels: &[CatchUpChannel],
) -> HashMap<String, Vec<Event>> {
    let requested = channels
        .iter()
        .map(|channel| (channel.id.to_ascii_lowercase(), channel))
        .collect::<HashMap<_, _>>();
    let mut by_channel = HashMap::<String, Vec<Event>>::new();
    for event in events {
        let Some(channel_id) = event_channel_id(&event).map(str::to_ascii_lowercase) else {
            continue;
        };
        let Some(channel) = requested.get(&channel_id) else {
            continue;
        };
        if !catch_up_kinds(&channel.channel_type).contains(&(event.kind.as_u16() as u32)) {
            continue;
        }
        by_channel.entry(channel_id).or_default().push(event);
    }
    by_channel
}

pub(super) async fn fetch_relevant_thread_events(
    state: &AppState,
    api_base: &str,
    keys: &Keys,
    channels: &[CatchUpChannel],
    roots: &[String],
) -> Result<HashMap<String, Vec<Event>>, String> {
    if channels.is_empty() || roots.is_empty() {
        return Ok(HashMap::new());
    }
    let filters = channels_by_frontier(channels)
        .into_values()
        .flat_map(|channels| {
            roots
                .chunks(ROOT_FILTER_CHUNK)
                .map(move |roots| relevant_thread_filter(&channels, roots))
        })
        .collect::<Vec<_>>();
    let pages = stream::iter(filters)
        .map(|filter| async move { fetch_filter_pages(state, api_base, keys, &filter).await })
        .buffered(CHANNEL_FETCH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut events = Vec::new();
    for page in pages {
        events.extend(page?);
    }
    let mut seen = HashSet::new();
    events.retain(|event| seen.insert(event.id));
    Ok(bucket_requested_events(events, channels))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(id: &str, channel_type: &str, read_at: Option<u64>) -> CatchUpChannel {
        CatchUpChannel {
            id: id.into(),
            channel_type: channel_type.into(),
            name: id.into(),
            read_at,
            timeline_read_at: read_at,
        }
    }

    #[test]
    fn one_root_filter_covers_channels_with_the_same_frontier() {
        let channels = vec![
            channel("a", "stream", Some(10)),
            channel("b", "dm", Some(10)),
        ];
        let filter = relevant_thread_filter(&channels, &["root".into()]);

        assert_eq!(filter["since"], 11);
        assert_eq!(filter["#e"], serde_json::json!(["root"]));
        assert_eq!(filter["#h"], serde_json::json!(["a", "b"]));
        assert!(filter["kinds"].as_array().is_some_and(
            |kinds| kinds.contains(&serde_json::json!(super::super::KIND_HUDDLE_STARTED))
        ));
    }

    #[test]
    fn channels_with_different_read_frontiers_are_partitioned() {
        let channels = vec![
            channel("old", "stream", None),
            channel("current", "stream", Some(900)),
            channel("same-current", "dm", Some(900)),
        ];

        let groups = channels_by_frontier(&channels);

        assert_eq!(groups.keys().copied().collect::<Vec<_>>(), [0, 901]);
        assert_eq!(
            groups[&0]
                .iter()
                .map(|channel| channel.id.as_str())
                .collect::<Vec<_>>(),
            ["old"]
        );
        assert_eq!(
            groups[&901]
                .iter()
                .map(|channel| channel.id.as_str())
                .collect::<Vec<_>>(),
            ["current", "same-current"]
        );
        assert_eq!(
            relevant_thread_filter(&groups[&901], &["root".into()])["since"],
            901
        );
    }
}

import Foundation

/// Swift counterpart of web voiceTranscript.ts and huddleAgentSpeech.ts.
/// Used by the live native voice path, also exercised by native XCTest.
enum NativeVoicePolicy {
    static let echoTail: TimeInterval = 1.5
    static func normalize(_ raw: String) -> String {
        raw.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func echoText(_ raw: String) -> String {
        normalize(raw.lowercased().replacingOccurrences(of: "[^\\p{L}\\p{N}\\s]+", with: "", options: .regularExpression))
    }
    static func isEcho(_ final: String, of utterances: [String]) -> Bool {
        let candidate = echoText(final)
        guard !candidate.isEmpty else { return false }
        let words = Set(candidate.split(separator: " "))
        for raw in utterances {
            let utterance = echoText(raw)
            guard !utterance.isEmpty else { continue }
            let other = Set(utterance.split(separator: " "))
            let shared = words.intersection(other).count
            let union = words.count + other.count - shared
            if union > 0 && Double(shared) / Double(union) >= 0.6 { return true }
            if utterance.utf16.count >= 15 && (candidate.contains(utterance) || utterance.contains(candidate)) { return true }
        }
        return false
    }
    static func chunks(_ text: String, max: Int = 200) -> [String] {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, max > 0 else { return [] }
        let regex = try? NSRegularExpression(pattern: "[^.!?…]+[.!?…]+(?:\\s+|$)|[^.!?…]+$")
        let source = normalized as NSString
        let matches = regex?.matches(in: normalized, range: NSRange(location: 0, length: source.length)) ?? []
        let sentences = matches.isEmpty ? [normalized] : matches.map { source.substring(with: $0.range) }
        var chunks: [String] = []; var current = ""
        for sentence in sentences {
            var piece = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
            if piece.isEmpty { continue }
            if piece.count > max {
                if !current.isEmpty { chunks.append(current); current = "" }
                while piece.count > max {
                    let prefix = String(piece.prefix(max))
                    if let space = prefix.lastIndex(of: " "), space != prefix.startIndex {
                        let chunk = String(prefix[..<space]).trimmingCharacters(in: .whitespacesAndNewlines)
                        chunks.append(chunk); piece = String(piece.dropFirst(prefix.distance(from: prefix.startIndex, to: space))).trimmingCharacters(in: .whitespacesAndNewlines)
                    } else { chunks.append(prefix); piece = String(piece.dropFirst(max)) }
                }
                current = piece
            } else if current.isEmpty { current = piece }
            else if current.count + piece.count + 1 <= max { current += " " + piece }
            else { chunks.append(current); current = piece }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
    static func voiceSelection(content: String, tags: [[String]]) -> (engine: String, key: String)? {
        guard tags.filter({ $0.first == "d" }).count == 1,
              tags.contains(["d", "agent-voice"]),
              let data = content.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              nativeInteger(value["version"]) == 1, let label = value["label"] as? String,
              !label.isEmpty, label.utf16.count <= 128,
              !label.unicodeScalars.contains(where: { $0.value <= 31 || $0.value == 127 }),
              let engine = value["engine"] as? String, let key = value["key"] as? String else { return nil }
        if engine == "pocket", key != "pocket:eve",
           key.range(of: "^pocket:(?:[a-z0-9_-]+|imported:[a-f0-9]{64})$", options: .regularExpression) != nil { return (engine, key) }
        if engine == "eleven", key.range(of: "^eleven:[A-Za-z0-9]{10,36}$", options: .regularExpression) != nil { return (engine, key) }
        return nil
    }
}

struct NativeFinalGate {
    private var recent: [String] = []
    private var utterances: [(text: String, at: TimeInterval)] = []
    private var pending: [String] = []
    private var holdStarted: TimeInterval?
    var hasPending: Bool { !pending.isEmpty }
    mutating func record(_ text: String, at: TimeInterval) {
        utterances.append((text, at))
        utterances = Array(utterances.filter { $0.at >= at - 120 }.suffix(50))
    }
    mutating func receive(_ raw: String, now: TimeInterval, speaking: Bool) -> String? {
        let text = NativeVoicePolicy.normalize(raw)
        guard text.utf16.count >= 3, !recent.contains(text) else { return nil }
        recent = Array((recent + [text]).suffix(3))
        if speaking || now - (utterances.last?.at ?? -.infinity) < NativeVoicePolicy.echoTail {
            if pending.isEmpty { holdStarted = now }
            pending.append(text); return nil
        }
        return text
    }
    mutating func drain(now: TimeInterval, speaking: Bool) -> [String] {
        guard !speaking, now - (utterances.last?.at ?? -.infinity) >= NativeVoicePolicy.echoTail else { return [] }
        let cutoff = (holdStarted ?? now) - NativeVoicePolicy.echoTail
        let comparable = utterances.filter { $0.at >= cutoff }.map(\.text)
        let result = pending.filter { !NativeVoicePolicy.isEcho($0, of: comparable) }
        pending.removeAll(); holdStarted = nil
        return result
    }
}

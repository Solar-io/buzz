import Foundation

/// Epoch and revision fence shared by native admission and packet routing.
struct HuddleRoster {
    struct Peer: Equatable { let pubkey: String; let index: Int; let epoch: Int }
    private(set) var peers: [Int: Peer] = [:]
    private(set) var revision = -1
    private(set) var admitted = false

    private func peer(_ value: [String: Any]) throws -> Peer {
        guard let key = value["pubkey"] as? String, key.count == 64, key.allSatisfy(\.isHexDigit),
              let index = nativeInteger(value["peer_index"]), (0...255).contains(index),
              let epoch = nativeInteger(value["epoch"]), (0...255).contains(epoch) else {
            throw NativeError.message("Invalid audio roster entry.")
        }
        return Peer(pubkey: key.lowercased(), index: index, epoch: epoch)
    }
    mutating func apply(_ message: [String: Any], selfPubkey: String) throws {
        guard let type = message["type"] as? String,
              let nextRevision = nativeInteger(message["revision"]), nextRevision >= 0 else { throw NativeError.message("Invalid audio roster revision.") }
        if nextRevision < revision {
            // A newer authoritative roster can arrive ahead of our admission
            // frame. Preserve that roster while accepting the matching self.
            if type == "joined" && !admitted {
                let own = try peer(message)
                guard own.pubkey == selfPubkey.lowercased(), peers[own.index] == own else { throw NativeError.message("Invalid audio admission identity.") }
                admitted = true
            }
            return
        }
        if type == "roster" || (type == "joined" && !admitted) {
            guard let values = message["peers"] as? [[String: Any]] else { throw NativeError.message("Missing audio roster snapshot.") }
            var next: [Int: Peer] = [:]
            for value in values {
                let item = try peer(value)
                guard next[item.index] == nil, !next.values.contains(where: { $0.pubkey == item.pubkey }) else { throw NativeError.message("Duplicate audio roster occupancy.") }
                next[item.index] = item
            }
            if type == "joined" {
                let own = try peer(message)
                guard own.pubkey == selfPubkey.lowercased(), next[own.index] == own else { throw NativeError.message("Invalid audio admission identity.") }
                admitted = true
            }
            peers = next; revision = nextRevision
            return
        }
        guard admitted else { throw NativeError.message("Audio peer update before admission.") }
        if nextRevision == revision { return }
        guard nextRevision == revision + 1 else { throw NativeError.message("Audio roster revision gap; reconnecting.") }
        let item = try peer(message)
        switch type {
        case "joined": peers[item.index] = item
        case "left": if peers[item.index] == item { peers.removeValue(forKey: item.index) }
        default: throw NativeError.message("Unknown audio roster update.")
        }
        revision = nextRevision
    }
    func accepts(_ data: Data) -> Bool {
        data.count > 10 && data.count <= 4096 && admitted && peers[Int(data[0])]?.epoch == Int(data[1])
    }
}

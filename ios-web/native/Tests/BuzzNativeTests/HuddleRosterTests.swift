import XCTest
@testable import BuzzNative

final class HuddleRosterTests: XCTestCase {
    private let own = String(repeating: "a", count: 64)
    private let other = String(repeating: "b", count: 64)
    private func peer(_ key: String, _ index: Int, _ epoch: Int) -> [String: Any] {
        ["pubkey": key, "peer_index": index, "epoch": epoch]
    }
    private func joined() -> [String: Any] {
        ["type": "joined", "revision": 4, "pubkey": own, "peer_index": 1, "epoch": 7,
         "peers": [peer(own, 1, 7), peer(other, 2, 8)]]
    }
    private func packet(index: UInt8, epoch: UInt8, length: Int = 12) -> Data {
        Data([index, epoch] + Array(repeating: 0, count: max(0, length - 2)))
    }

    func testBooleanAndFractionalRosterNumbersAreRejectedBeforeAdmission() {
        for invalid in [true, 1.5] as [Any] {
            var roster = HuddleRoster()
            var message = joined()
            message["revision"] = invalid
            XCTAssertThrowsError(try roster.apply(message, selfPubkey: own))
            XCTAssertFalse(roster.admitted)
            for field in ["peer_index", "epoch"] {
                message = joined()
                var entry = peer(own, 1, 7)
                entry[field] = invalid
                message["peers"] = [entry]
                XCTAssertThrowsError(try roster.apply(message, selfPubkey: own))
                XCTAssertFalse(roster.admitted)
            }
        }
    }

    func testAdmissionIdentityAndPacketEpochGuard() throws {
        var roster = HuddleRoster()
        XCTAssertFalse(roster.accepts(packet(index: 2, epoch: 8)))
        XCTAssertThrowsError(try roster.apply(joined(), selfPubkey: other))
        XCTAssertFalse(roster.admitted)
        try roster.apply(joined(), selfPubkey: own)
        XCTAssertTrue(roster.admitted)
        XCTAssertEqual(roster.peers.count, 2)
        XCTAssertTrue(roster.accepts(packet(index: 2, epoch: 8)))
        XCTAssertFalse(roster.accepts(packet(index: 2, epoch: 7)))
        XCTAssertFalse(roster.accepts(packet(index: 3, epoch: 8)))
        XCTAssertFalse(roster.accepts(packet(index: 2, epoch: 8, length: 10)))
        XCTAssertFalse(roster.accepts(packet(index: 2, epoch: 8, length: 4097)))
    }

    func testRevisionGapFailsWithoutApplyingUpdateAndStaleLeaveCannotEvictReplacement() throws {
        var roster = HuddleRoster()
        try roster.apply(joined(), selfPubkey: own)
        var newer = peer(other, 2, 9)
        newer["type"] = "joined"; newer["revision"] = 6
        XCTAssertThrowsError(try roster.apply(newer, selfPubkey: own))
        XCTAssertEqual(roster.revision, 4)
        XCTAssertTrue(roster.accepts(packet(index: 2, epoch: 8)))
        newer["revision"] = 5
        try roster.apply(newer, selfPubkey: own)
        XCTAssertTrue(roster.accepts(packet(index: 2, epoch: 9)))
        XCTAssertFalse(roster.accepts(packet(index: 2, epoch: 8)))
        var staleLeave = peer(other, 2, 8)
        staleLeave["type"] = "left"; staleLeave["revision"] = 6
        try roster.apply(staleLeave, selfPubkey: own)
        XCTAssertTrue(roster.accepts(packet(index: 2, epoch: 9)))
        staleLeave["epoch"] = 9; staleLeave["revision"] = 7
        try roster.apply(staleLeave, selfPubkey: own)
        XCTAssertFalse(roster.accepts(packet(index: 2, epoch: 9)))
    }

    func testMalformedSnapshotCannotReplaceAcceptedRoster() throws {
        var roster = HuddleRoster()
        try roster.apply(joined(), selfPubkey: own)
        for rows in [[peer(own, 1, 7), peer(other, 1, 8)], [peer(own, 1, 7), peer(own, 2, 8)], [peer(other, 256, 8)], [peer("invalid", 2, 8)]] {
            XCTAssertThrowsError(try roster.apply(["type": "roster", "revision": 5, "peers": rows], selfPubkey: own))
            XCTAssertEqual(roster.revision, 4)
            XCTAssertEqual(roster.peers.count, 2)
        }
    }
}

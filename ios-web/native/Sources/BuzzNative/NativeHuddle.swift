import AVFoundation
import Foundation

/// Owns the call, authentication and network transport outside WKWebView.
/// All mutable state is serialized on the main queue; audio callbacks hop here.
final class NativeHuddle {
    static let shared = NativeHuddle()
    var onState: (([String: Any]) -> Void)?
    private(set) var channel: String?
    private(set) var parent: String?
    private(set) var status = "idle"
    private(set) var muted = false
    private(set) var speaker = true
    private(set) var voiceEnabled = false
    private(set) var speechEnabled = false
    private(set) var error: String?
    var isIdle: Bool { channel == nil }
    private var relayURL: URL?
    private var audioSocket: URLSessionWebSocketTask?
    private var engine: HuddleAudioEngine?
    private var generation = 0
    private var retry = 0
    private var timeout: DispatchWorkItem?
    private var peers: [Int: (pubkey: String, epoch: Int)] = [:]
    private var revision = -1
    private var observers: [NSObjectProtocol] = []
    private var held = false
    private var interrupted = false
    private var voice: NativeAgentVoice?

    private init() {
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            self.interrupted = began
            self.engine?.setInterrupted(began)
            self.voice?.setCaptureAllowed(!began && !self.muted && !self.held)
            if !began, self.channel != nil {
                do { try AVAudioSession.sharedInstance().setActive(true) }
                catch { self.fail(error.localizedDescription) }
            }
            self.emit()
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.fail("The audio service restarted. Leave and rejoin the call.")
        })
    }

    func snapshot() -> [String: Any] {
        ["status": status, "channelId": channel as Any? ?? NSNull(),
         "parentChannelId": parent as Any? ?? NSNull(), "muted": muted,
         "speaker": speaker, "voiceEnabled": voiceEnabled, "speechEnabled": speechEnabled,
         "speaking": voice?.speaking ?? false, "interim": voice?.interim ?? "",
         "error": error as Any? ?? NSNull(),
         "peers": peers.map { ["peerIndex": $0.key, "pubkey": $0.value.pubkey, "epoch": $0.value.epoch] as [String: Any] }]
    }
    func emit() { onState?(snapshot()) }

    func join(relay: String, channel: String, parent: String, stt: String, tts: String) throws {
        guard isIdle else { throw NativeError.message("Leave the current call first.") }
        guard let url = URL(string: relay), url.scheme == "wss", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              UUID(uuidString: channel) != nil, UUID(uuidString: parent) != nil else {
            throw NativeError.message("A secure relay and valid channel identifiers are required.")
        }
        _ = try NativeIdentity.shared.signer()
        self.channel = channel; self.parent = parent; relayURL = url
        generation += 1; retry = 0; error = nil; muted = false; held = false
        status = "connecting"; emit()
        let activeGeneration = generation
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.generation == activeGeneration else { return }
                guard granted else { self.fail("Microphone permission was denied."); return }
                do {
                    let session = AVAudioSession.sharedInstance()
                    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
                    try session.setActive(true)
                    self.engine = try HuddleAudioEngine(onLocalPacket: { [weak self] packet in
                        DispatchQueue.main.async { self?.sendAudio(packet, generation: activeGeneration) }
                    }, onFailure: { [weak self] _, message in
                        DispatchQueue.main.async { self?.fail(message) }
                    }, onDiagnostics: { _ in }, diagnosticsEnabled: false, onPCM: { [weak self] samples in
                        DispatchQueue.main.async { self?.voice?.capture(samples) }
                    })
                    try self.engine?.start()
                    self.voice = try NativeAgentVoice(relay: url, channel: channel, stt: stt, tts: tts, onChange: { [weak self] in self?.emit() }, onSpeaking: { [weak self] speaking in
                        guard let self else { return }
                        try? self.engine?.setMuted(self.muted || self.held || speaking)
                    }, audioPeers: { [weak self] in Set(self?.peers.values.map(\.pubkey) ?? []) })
                    self.voice?.start()
                    self.connectAudio(activeGeneration)
                } catch { self.fail(error.localizedDescription) }
            }
        }
    }

    func configure(muted: Bool?, speaker: Bool?, voiceEnabled: Bool?, speechEnabled: Bool?, held: Bool?) throws {
        if let muted { self.muted = muted }
        if let held { self.held = held }
        if let speaker {
            self.speaker = speaker
            try AVAudioSession.sharedInstance().overrideOutputAudioPort(speaker ? .speaker : .none)
        }
        if let voiceEnabled { self.voiceEnabled = voiceEnabled }
        if let speechEnabled { self.speechEnabled = speechEnabled }
        try engine?.setMuted(self.muted || self.held || (voice?.speaking ?? false))
        voice?.configure(voice: self.voiceEnabled, speech: self.speechEnabled, capture: !self.muted && !self.held && !interrupted)
        emit()
    }

    func leave() {
        generation += 1; timeout?.cancel(); timeout = nil
        audioSocket?.cancel(with: .normalClosure, reason: nil); audioSocket = nil
        voice?.stop(); voice = nil
        engine?.stop(); engine = nil
        peers.removeAll(); channel = nil; parent = nil; relayURL = nil
        status = "idle"; voiceEnabled = false; speechEnabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        emit()
    }
    private func fail(_ message: String) { leave(); error = message; status = "error"; emit() }

    private func connectAudio(_ token: Int) {
        guard generation == token, let base = relayURL, let channel else { return }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = "/huddle/\(channel)/audio"
        guard let url = components?.url else { fail("Invalid audio endpoint."); return }
        let socket = URLSession.shared.webSocketTask(with: url)
        audioSocket = socket
        revision = -1; peers.removeAll()
        socket.resume()
        receive(socket, token)
        let deadline = DispatchWorkItem { [weak self, weak socket] in
            guard let self, let socket, self.audioSocket === socket, self.status != "connected" else { return }
            self.connectionLost(token, "Audio handshake timed out.")
        }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: deadline)
    }

    private func receive(_ socket: URLSessionWebSocketTask, _ token: Int) {
        socket.receive { [weak self, weak socket] result in
            DispatchQueue.main.async {
                guard let self, let socket, self.generation == token, self.audioSocket === socket else { return }
                switch result {
                case .failure: self.connectionLost(token, "Audio connection lost."); return
                case .success(.string(let text)): self.control(text, socket: socket, token: token)
                case .success(.data(let data)): self.play(data)
                @unknown default: break
                }
                if self.audioSocket === socket { self.receive(socket, token) }
            }
        }
    }
    private func control(_ text: String, socket: URLSessionWebSocketTask, token: Int) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let type = value["type"] as? String else { return }
        do {
            switch type {
            case "challenge":
                guard let challenge = value["challenge"] as? String, !challenge.isEmpty, let relayURL, let parent else { throw NativeError.message("Invalid audio challenge.") }
                let auth = try NativeIdentity.shared.sign(["kind": 22242, "content": "", "tags": [["relay", relayURL.absoluteString], ["challenge", challenge]]])
                sendJSON(["type": "auth", "event": auth, "parent_channel_id": parent, "protocol_version": 3], socket: socket)
            case "joined", "roster":
                let nextRevision = value["revision"] as? Int ?? revision + 1
                guard nextRevision >= revision else { return }
                if let rows = value["peers"] as? [[String: Any]] {
                    var next: [Int: (pubkey: String, epoch: Int)] = [:]
                    for row in rows {
                        if let index = row["peer_index"] as? Int, let key = row["pubkey"] as? String, let epoch = row["epoch"] as? Int, (0...255).contains(index), (0...255).contains(epoch) { next[index] = (key, epoch) }
                    }
                    if type == "roster" || status != "connected" { peers = next }
                }
                if let index = value["peer_index"] as? Int, let key = value["pubkey"] as? String, let epoch = value["epoch"] as? Int {
                    if peers[index]?.epoch != epoch { engine?.removeRemotePeer(index) }
                    peers[index] = (key, epoch)
                }
                revision = nextRevision; status = "connected"; retry = 0; timeout?.cancel(); emit()
            case "left":
                if let index = value["peer_index"] as? Int, let epoch = value["epoch"] as? Int, peers[index]?.epoch == epoch {
                    peers.removeValue(forKey: index); engine?.removeRemotePeer(index); emit()
                }
            case "error": throw NativeError.message(value["message"] as? String ?? "The relay refused this huddle.")
            default: break
            }
        } catch { fail(error.localizedDescription) }
    }
    private func connectionLost(_ token: Int, _ message: String) {
        guard generation == token, channel != nil else { return }
        audioSocket?.cancel(with: .goingAway, reason: nil); audioSocket = nil; timeout?.cancel()
        retry += 1
        if retry > 6 { fail(message); return }
        status = "reconnecting"; emit()
        DispatchQueue.main.asyncAfter(deadline: .now() + min(16, pow(2, Double(retry - 1)))) { [weak self] in self?.connectAudio(token) }
    }
    private func sendAudio(_ packet: HuddleLocalOpusPacket, generation token: Int) {
        guard token == generation, status == "connected", let audioSocket, !muted, !held else { return }
        var data = Data([UInt8((packet.sequence >> 8) & 255), UInt8(packet.sequence & 255)])
        let timestamp = UInt32(truncatingIfNeeded: packet.timestamp48k)
        data.append(contentsOf: [24, 16, 8, 0].map { UInt8((timestamp >> $0) & 255) })
        data.append(UInt8(bitPattern: Int8(clamping: packet.levelDbov))); data.append(UInt8(packet.flags))
        data.append(packet.opus)
        audioSocket.send(.data(data)) { _ in }
    }
    private func play(_ data: Data) {
        guard data.count > 10, let peer = peers[Int(data[0])], peer.epoch == Int(data[1]) else { return }
        let sequence = Int(data[2]) << 8 | Int(data[3])
        let timestamp = data[4..<8].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        do { try engine?.enqueueRemote(HuddleRemoteOpusPacket(peerIndex: Int(data[0]), sequence: sequence, timestamp48k: Int64(timestamp), levelDbov: Int(Int8(bitPattern: data[8])), opus: Data(data.dropFirst(10)))) }
        catch { self.error = error.localizedDescription; emit() }
    }
}

func sendJSON(_ value: Any, socket: URLSessionWebSocketTask) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value), let text = String(data: bytes, encoding: .utf8) else { return }
    socket.send(.string(text)) { _ in }
}

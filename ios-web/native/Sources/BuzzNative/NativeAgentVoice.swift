import AVFoundation
import Foundation
import NostrSDK

/// Relay/STT/TTS session survives a suspended WebView. Capture is fail-closed
/// until the current room's signed membership snapshot and STT ready arrive.
final class NativeAgentVoice: NSObject, AVAudioPlayerDelegate {
    private let relay: URL
    private let channel: String
    private let sttURL: URL
    private let ttsURL: URL
    private let onChange: () -> Void
    private let onSpeaking: (Bool) -> Void
    private let audioPeers: () -> Set<String>
    private var relaySocket: URLSessionWebSocketTask?
    private var sttSocket: URLSessionWebSocketTask?
    private var generation = 0
    private var alive = false
    private var relayReady = false
    private var sttReady = false
    private var voice = false
    private var speech = false
    private var captureAllowed = true
    private var membersReady = false
    private var agents = Set<String>()
    private var relayPubkey: String?
    private var voices: [String: (Int, String, String)] = [:]
    private var pendingMessages: [[String: Any]] = []
    private var pendingPublications: [String: [String: Any]] = [:]
    private var seen = Set<String>()
    private var finals: [String] = []
    private var pcm = Data()
    private var player: AVAudioPlayer?
    private var synthesis: URLSessionDataTask?
    private var speechQueue: [(String, String)] = []
    private var lastSpeechEnded = Date.distantPast
    private var retry = 0
    private var sttRetry = 0
    var duplex = "half"
    private var outputMuted = false
    private var overrideVoice: (String, String)?
    private var micHotSince: Date?
    private var lastSpoken = ""
    private(set) var speaking = false
    private(set) var interim = ""
    var error: String?

    init(relay: URL, channel: String, stt: String, tts: String,
         onChange: @escaping () -> Void, onSpeaking: @escaping (Bool) -> Void,
         audioPeers: @escaping () -> Set<String>) throws {
        guard let sttURL = URL(string: stt), sttURL.scheme == "wss", sttURL.host != nil,
              let ttsURL = URL(string: tts), ttsURL.scheme == "https", ttsURL.host != nil else {
            throw NativeError.message("Configure secure speech service URLs before joining.")
        }
        self.relay = relay; self.channel = channel; self.sttURL = sttURL; self.ttsURL = ttsURL
        self.onChange = onChange; self.onSpeaking = onSpeaking; self.audioPeers = audioPeers
    }

    func start() {
        alive = true; generation += 1
        let token = generation
        var info = URLComponents(url: relay, resolvingAgainstBaseURL: false)
        info?.scheme = "https"; info?.path = "/info"
        guard let url = info?.url else { return }
        URLSession.shared.dataTask(with: url) { [weak self] bytes, _, _ in
            DispatchQueue.main.async {
                guard let self, self.alive, self.generation == token,
                      let bytes, let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let pubkey = value["pubkey"] as? String, pubkey.count == 64 else {
                    self?.report("Relay identity discovery failed; voice is unavailable."); return
                }
                self.relayPubkey = pubkey
                self.connectRelay(token)
            }
        }.resume()
    }

    func configure(voice: Bool, speech: Bool, capture: Bool) {
        let changed = self.voice != voice
        self.voice = voice; self.speech = speech; captureAllowed = capture
        if changed {
            sttSocket?.cancel(with: .normalClosure, reason: nil); sttSocket = nil; sttReady = false; pcm.removeAll()
            sttRetry = 0
            if voice { connectSTT(generation) }
        }
        if !speech { synthesis?.cancel(); synthesis = nil; player?.stop(); player = nil; speechQueue.removeAll(); endSpeech() }
        if !capture { pcm.removeAll(); interim = "" }
        onChange()
    }
    func setCaptureAllowed(_ value: Bool) { captureAllowed = value; if !value { pcm.removeAll() } }
    func setOutputMuted(_ value: Bool) { outputMuted = value; player?.volume = value ? 0 : 1 }
    func setVoiceOverride(_ value: [String: Any]) {
        if let engine = value["engine"] as? String, ["pocket", "eleven"].contains(engine), let key = value["key"] as? String, key.hasPrefix(engine + ":") { overrideVoice = (engine, String(key.dropFirst(engine.count + 1))) }
        else { overrideVoice = nil }
    }
    func interruptSpeech() {
        synthesis?.cancel(); synthesis = nil; player?.stop(); player = nil
        speechQueue.removeAll(); endSpeech()
    }
    func stop() {
        alive = false; generation += 1; relayReady = false; sttReady = false
        relaySocket?.cancel(with: .normalClosure, reason: nil); relaySocket = nil
        sttSocket?.cancel(with: .normalClosure, reason: nil); sttSocket = nil
        synthesis?.cancel(); synthesis = nil; player?.stop(); player = nil
        speechQueue.removeAll(); pendingPublications.removeAll(); pcm.removeAll(); endSpeech()
    }

    func capture(_ frame: [Float]) {
        guard alive, voice, captureAllowed, sttReady, relayReady, membersReady, !agents.isEmpty,
              (duplex == "barge" || !speaking), (duplex == "barge" || Date().timeIntervalSince(lastSpeechEnded) > 0.7), let socket = sttSocket else { pcm.removeAll(); return }
        let level = HuddleAudioLevels.rmsDbov(frame)
        if level > -45 { if micHotSince == nil { micHotSince = Date() } } else { micHotSince = nil }
        // The native capture engine delivers fixed 48k mono frames. Average
        // triples (anti-alias box filter) into the bridge's PCM16LE 16k format.
        for i in stride(from: 0, to: frame.count - 2, by: 3) {
            let sample = min(1, max(-1, (frame[i] + frame[i + 1] + frame[i + 2]) / 3))
            let integer = Int16(sample * (sample < 0 ? 32768 : 32767))
            let bits = UInt16(bitPattern: integer)
            pcm.append(UInt8(bits & 255)); pcm.append(UInt8(bits >> 8))
        }
        while pcm.count >= 3200 {
            let batch = Data(pcm.prefix(3200)); pcm.removeFirst(3200)
            socket.send(.data(batch)) { _ in }
        }
    }

    private func connectRelay(_ token: Int) {
        guard alive, generation == token else { return }
        membersReady = false; relayReady = false
        let socket = URLSession.shared.webSocketTask(with: relay)
        relaySocket = socket; socket.resume(); readRelay(socket, token)
        // Public relays may accept REQ before challenging; reissue after AUTH.
        subscribe(socket)
        heartbeat(socket, token)
    }
    private func subscribe(_ socket: URLSessionWebSocketTask) {
        sendJSON(["REQ", "native-members", ["kinds": [39002], "#d": [channel], "authors": [relayPubkey ?? ""], "limit": 1]], socket: socket)
        sendJSON(["REQ", "native-voice", ["kinds": [9, 40002], "#h": [channel], "since": Int(Date().timeIntervalSince1970) - 5]], socket: socket)
    }
    private func heartbeat(_ socket: URLSessionWebSocketTask, _ token: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self, weak socket] in
            guard let self, let socket, self.alive, self.generation == token, self.relaySocket === socket else { return }
            socket.sendPing { _ in }
            self.heartbeat(socket, token)
        }
    }
    private func readRelay(_ socket: URLSessionWebSocketTask, _ token: Int) {
        socket.receive { [weak self, weak socket] result in
            DispatchQueue.main.async {
                guard let self, let socket, self.alive, self.generation == token, self.relaySocket === socket else { return }
                switch result {
                case .failure:
                    self.relayReady = false; self.membersReady = false; self.retry += 1
                    if self.retry > 6 { self.report("Voice relay disconnected; rejoin to resume."); return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + min(16, pow(2, Double(self.retry - 1)))) { self.connectRelay(token) }
                    return
                case .success(.string(let text)): self.handleRelay(text, socket)
                default: break
                }
                self.readRelay(socket, token)
            }
        }
    }
    private func handleRelay(_ text: String, _ socket: URLSessionWebSocketTask) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any], let type = value.first as? String else { return }
        do {
            if type == "AUTH", value.count > 1, let challenge = value[1] as? String {
                let event = try NativeIdentity.shared.sign(["kind": 22242, "content": "", "tags": [["relay", relay.absoluteString], ["challenge", challenge]]])
                sendJSON(["AUTH", event], socket: socket)
            } else if type == "OK", value.count > 2, let id = value[1] as? String, let accepted = value[2] as? Bool {
                if pendingPublications.removeValue(forKey: id) != nil {
                    if !accepted { report("The relay refused a voice transcript.") }
                } else if accepted { subscribe(socket) }
            } else if type == "EOSE", value.count > 1, value[1] as? String == "native-members" {
                relayReady = true; retry = 0
            } else if type == "EVENT", value.count > 2, let event = value[2] as? [String: Any] {
                let bytes = try JSONSerialization.data(withJSONObject: event)
                let verified = try Event.fromJson(json: String(decoding: bytes, as: UTF8.self))
                guard verified.verify() else { return }
                process(event, socket)
            }
        } catch { report("Voice relay authentication or event validation failed.") }
    }
    private func process(_ event: [String: Any], _ socket: URLSessionWebSocketTask) {
        guard let kind = event["kind"] as? Int, let author = event["pubkey"] as? String,
              let content = event["content"] as? String, let tags = event["tags"] as? [[String]] else { return }
        if kind == 39002, author == relayPubkey, tags.contains(where: { $0.count > 1 && $0[0] == "d" && $0[1] == channel }) {
            agents = Set(tags.filter { $0.count > 3 && $0[0] == "p" && $0[3] == "bot" }.map { $0[1] })
            membersReady = true; relayReady = true; retry = 0
            if !agents.isEmpty { sendJSON(["REQ", "native-selections", ["kinds": [30182], "authors": Array(agents), "#d": ["agent-voice"]]], socket: socket) }
            let buffered = pendingMessages; pendingMessages.removeAll()
            buffered.forEach { process($0, socket) }
        } else if kind == 30182, agents.contains(author), let data = content.data(using: .utf8),
                  let selection = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let engine = selection["engine"] as? String, ["pocket", "eleven"].contains(engine),
                  let key = selection["key"] as? String, key.hasPrefix(engine + ":"),
                  let date = event["created_at"] as? Int, date >= (voices[author]?.0 ?? 0) {
            voices[author] = (date, engine, String(key.dropFirst(engine.count + 1)))
        } else if [9, 40002].contains(kind), tags.contains(where: { $0.count > 1 && $0[0] == "h" && $0[1] == channel }) {
            if !membersReady { if pendingMessages.count < 32 { pendingMessages.append(event) }; return }
            guard speech, agents.contains(author), !audioPeers().contains(author), let id = event["id"] as? String,
                  !seen.contains(id), !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !content.hasPrefix("[System]") else { return }
            seen.insert(id)
            if seen.count > 2048 { seen = [id] }
            if speechQueue.count < 24 { speechQueue.append((author, String(content.prefix(12000)))) }
            playNext()
        }
    }

    private func connectSTT(_ token: Int) {
        guard alive, voice, generation == token else { return }
        let socket = URLSession.shared.webSocketTask(with: sttURL)
        sttSocket = socket; socket.resume(); readSTT(socket, token)
    }
    private func readSTT(_ socket: URLSessionWebSocketTask, _ token: Int) {
        socket.receive { [weak self, weak socket] result in
            DispatchQueue.main.async {
                guard let self, let socket, self.alive, self.generation == token, self.sttSocket === socket else { return }
                switch result {
                case .failure:
                    self.sttReady = false; self.sttRetry += 1; self.pcm.removeAll()
                    if self.sttRetry > 6 { self.report("Speech recognition disconnected; turn voice mode off and on to retry."); return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + min(16, pow(2, Double(self.sttRetry - 1)))) { self.connectSTT(token) }
                    return
                case .success(.string(let text)):
                    if let event = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
                        switch event["type"] as? String {
                        case "ready": self.sttReady = true; self.sttRetry = 0
                        case "partial":
                            self.interim = event["text"] as? String ?? ""
                            if self.duplex == "barge", self.speaking, let since = self.micHotSince, Date().timeIntervalSince(since) >= 0.3, !self.interim.isEmpty, !self.lastSpoken.lowercased().contains(self.interim.lowercased()) { self.interruptSpeech() }
                            self.onChange()
                        case "final": self.final(event["text"] as? String ?? "")
                        case "error": self.report(event["message"] as? String ?? "Speech recognition failed."); self.sttReady = false
                        default: break
                        }
                    }
                default: break
                }
                self.readSTT(socket, token)
            }
        }
    }
    private func final(_ text: String) {
        interim = ""; onChange()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard voice, captureAllowed, (duplex == "barge" || !speaking), (duplex == "barge" || Date().timeIntervalSince(lastSpeechEnded) > 0.7),
              !trimmed.isEmpty, !finals.contains(trimmed) else { return }
        if (speaking || Date().timeIntervalSince(lastSpeechEnded) < 0.7) && lastSpoken.lowercased().contains(trimmed.lowercased()) { return }
        guard relayReady, membersReady, !agents.isEmpty, let relaySocket else { report("Transcript could not be sent: no connected agent roster."); return }
        do {
            let event = try NativeIdentity.shared.sign(["kind": 9, "content": "[voice] " + trimmed,
                "tags": [["h", channel]] + agents.sorted().map { ["p", $0] }])
            guard let id = event["id"] as? String else { return }
            pendingPublications[id] = event
            sendJSON(["EVENT", event], socket: relaySocket)
            finals.append(trimmed); if finals.count > 8 { finals.removeFirst() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                if self?.pendingPublications.removeValue(forKey: id) != nil { self?.report("Voice transcript delivery was not acknowledged.") }
            }
        } catch { report("Could not sign the voice transcript.") }
    }

    private func playNext() {
        guard alive, speech, !speaking, !speechQueue.isEmpty else { return }
        let (author, text) = speechQueue.removeFirst()
        if audioPeers().contains(author) { playNext(); return }
        let presets = ["anna", "vera", "fantine", "charles", "paul", "eponine", "azelma", "george", "mary", "jane", "michael"]
        var hash: Int32 = 5381
        for byte in author.utf8 { hash = hash &* 33 &+ Int32(byte) }
        let defaultVoice = presets[Int(abs(Int64(hash))) % presets.count]
        let selection = voices[author]
        let voiceName = overrideVoice?.1 ?? (selection?.2.hasPrefix("imported:") == false ? selection!.2 : defaultVoice)
        let engineName = overrideVoice?.0 ?? (selection?.2.hasPrefix("imported:") == false ? selection!.1 : "pocket")
        var request = URLRequest(url: ttsURL); request.httpMethod = "POST"; request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["engine": engineName, "voice": voiceName, "text": text])
        lastSpoken = text
        speaking = true; onSpeaking(duplex == "half"); onChange()
        let token = generation
        synthesis = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, self.alive, self.generation == token, self.speech else { return }
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data,
                      !data.isEmpty, data.count.isMultiple(of: 2), data.count <= 24_000 * 2 * 180 else {
                    self.report("Agent speech playback failed."); self.endSpeech(); return
                }
                do {
                    let player = try AVAudioPlayer(data: Self.wav(data))
                    self.player = player; player.delegate = self; player.volume = self.outputMuted ? 0 : 1
                    guard player.play() else { throw NativeError.message("Audio playback unavailable.") }
                } catch { self.report(error.localizedDescription); self.endSpeech() }
            }
        }
        synthesis?.resume()
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { endSpeech() }
    private func endSpeech() {
        speaking = false; lastSpeechEnded = Date(); player = nil
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            guard let self, self.generation == token else { return }
            self.onSpeaking(false); self.onChange(); self.playNext()
        }
    }
    private func report(_ message: String) { error = message; onChange() }
    private static func wav(_ pcm: Data) -> Data {
        var data = Data("RIFF".utf8)
        func u32(_ value: UInt32) { data.append(contentsOf: [0, 8, 16, 24].map { UInt8((value >> $0) & 255) }) }
        func u16(_ value: UInt16) { data.append(UInt8(value & 255)); data.append(UInt8(value >> 8)) }
        u32(UInt32(pcm.count + 36)); data.append(Data("WAVEfmt ".utf8)); u32(16)
        u16(1); u16(1); u32(24000); u32(48000); u16(2); u16(16)
        data.append(Data("data".utf8)); u32(UInt32(pcm.count)); data.append(pcm)
        return data
    }
}

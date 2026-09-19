import AVFoundation
import Foundation

struct HuddleLocalOpusPacket {
  let sequence: Int
  let timestamp48k: Int
  let levelDbov: Int
  let flags: Int
  let opus: Data
}

struct HuddleRemoteOpusPacket {
  let peerIndex: Int
  let sequence: Int
  let timestamp48k: Int64
  let levelDbov: Int
  let opus: Data
}

struct HuddlePacketJitterQueue {
  private(set) var packets: [HuddleRemoteOpusPacket] = []
  private var lastDrainedSequence: Int?
  private var started = false
  let capacity: Int
  let startPackets: Int

  init(capacity: Int, startPackets: Int) {
    self.capacity = capacity
    self.startPackets = startPackets
  }

  mutating func enqueue(_ packet: HuddleRemoteOpusPacket) {
    if let last = lastDrainedSequence, !sequenceAfter(packet.sequence, last) {
      return
    }
    guard !packets.contains(where: { $0.sequence == packet.sequence }) else {
      return
    }
    let index = packets.firstIndex {
      sequenceBefore(packet.sequence, $0.sequence)
    } ?? packets.endIndex
    packets.insert(packet, at: index)
    if packets.count > capacity { packets.removeFirst() }
    if packets.count >= startPackets { started = true }
  }

  mutating func drainOne() -> HuddleRemoteOpusPacket? {
    guard started, !packets.isEmpty else { return nil }
    let packet = packets.removeFirst()
    lastDrainedSequence = packet.sequence
    return packet
  }

  private func sequenceAfter(_ sequence: Int, _ reference: Int) -> Bool {
    let distance = (sequence - reference) & 0xffff
    return distance > 0 && distance <= 0x7fff
  }

  private func sequenceBefore(_ left: Int, _ right: Int) -> Bool {
    sequenceAfter(right, left)
  }
}

struct HuddleCaptureDiagnostics {
  let frameCount: Int64
  let rmsDbovHistogram: [String: Int64]
  let peakDbovHistogram: [String: Int64]
  let maxPeakDbov: Int
  let deviceLabel: String?
  let voiceProcessingEnabled: Bool
}

enum HuddleNativeMediaError: LocalizedError {
  case invalidState(String)
  case unsupported(String)
  case conversion(String)
  case malformedPacket(String)

  var errorDescription: String? {
    switch self {
    case .invalidState(let message),
      .unsupported(let message),
      .conversion(let message),
      .malformedPacket(let message):
      message
    }
  }
}

enum HuddleAudioFormats {
  static let sampleRate = 48_000.0
  static let channels: AVAudioChannelCount = 1
  static let frameSamples = 960
  static let maximumOpusPacketBytes = 4_088

  static func makePCM() throws -> AVAudioFormat {
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: sampleRate,
        channels: channels,
        interleaved: false
      )
    else {
      throw HuddleNativeMediaError.unsupported(
        "iOS does not expose 48 kHz mono PCM audio."
      )
    }
    return format
  }

  static func makeOpus() throws -> AVAudioFormat {
    var description = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatOpus,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: UInt32(frameSamples),
      mBytesPerFrame: 0,
      mChannelsPerFrame: channels,
      mBitsPerChannel: 0,
      mReserved: 0
    )
    guard let format = AVAudioFormat(streamDescription: &description) else {
      throw HuddleNativeMediaError.unsupported(
        "iOS does not expose the native Opus audio format."
      )
    }
    return format
  }
}

final class HuddleOpusEncoder {
  private let pcmFormat: AVAudioFormat
  private let opusFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private let maximumPacketSize: Int

  init() throws {
    let pcmFormat = try HuddleAudioFormats.makePCM()
    let opusFormat = try HuddleAudioFormats.makeOpus()
    guard let converter = AVAudioConverter(from: pcmFormat, to: opusFormat) else {
      throw HuddleNativeMediaError.unsupported(
        "This iOS device does not expose an Opus encoder."
      )
    }
    converter.bitRate = 32_000
    converter.primeMethod = .none
    self.pcmFormat = pcmFormat
    self.opusFormat = opusFormat
    self.converter = converter
    maximumPacketSize = max(1_275, converter.maximumOutputPacketSize)
  }

  func encode(_ samples: [Float]) throws -> Data {
    guard samples.count == HuddleAudioFormats.frameSamples else {
      throw HuddleNativeMediaError.conversion(
        "Opus input must contain exactly 960 samples."
      )
    }
    guard
      let pcm = AVAudioPCMBuffer(
        pcmFormat: pcmFormat,
        frameCapacity: AVAudioFrameCount(HuddleAudioFormats.frameSamples)
      ),
      let channel = pcm.floatChannelData?.pointee
    else {
      throw HuddleNativeMediaError.conversion(
        "Unable to allocate the iOS Opus input buffer."
      )
    }
    pcm.frameLength = AVAudioFrameCount(HuddleAudioFormats.frameSamples)
    for index in samples.indices {
      channel[index] = samples[index]
    }

    let compressed = AVAudioCompressedBuffer(
      format: opusFormat,
      packetCapacity: 1,
      maximumPacketSize: maximumPacketSize
    )
    var suppliedInput = false
    var conversionError: NSError?
    let status = converter.convert(
      to: compressed,
      error: &conversionError
    ) { _, inputStatus in
      guard !suppliedInput else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return pcm
    }
    if status == .error || conversionError != nil {
      throw HuddleNativeMediaError.conversion(
        conversionError?.localizedDescription ?? "iOS Opus encoding failed."
      )
    }
    let byteCount = Int(compressed.byteLength)
    guard
      compressed.packetCount == 1,
      byteCount > 0,
      byteCount <= HuddleAudioFormats.maximumOpusPacketBytes
    else {
      throw HuddleNativeMediaError.conversion(
        "iOS produced an invalid Opus packet."
      )
    }
    return Data(bytes: compressed.data, count: byteCount)
  }
}

final class HuddleOpusDecoder {
  private let pcmFormat: AVAudioFormat
  private let opusFormat: AVAudioFormat
  private let converter: AVAudioConverter

  init() throws {
    let pcmFormat = try HuddleAudioFormats.makePCM()
    let opusFormat = try HuddleAudioFormats.makeOpus()
    guard let converter = AVAudioConverter(from: opusFormat, to: pcmFormat) else {
      throw HuddleNativeMediaError.unsupported(
        "This iOS device does not expose an Opus decoder."
      )
    }
    converter.primeMethod = .none
    self.pcmFormat = pcmFormat
    self.opusFormat = opusFormat
    self.converter = converter
  }

  func decode(_ packet: Data) throws -> AVAudioPCMBuffer {
    guard
      !packet.isEmpty,
      packet.count <= HuddleAudioFormats.maximumOpusPacketBytes
    else {
      throw HuddleNativeMediaError.malformedPacket(
        "Remote Huddle Opus packet has an invalid length."
      )
    }
    let compressed = AVAudioCompressedBuffer(
      format: opusFormat,
      packetCapacity: 1,
      maximumPacketSize: HuddleAudioFormats.maximumOpusPacketBytes
    )
    packet.withUnsafeBytes { bytes in
      guard let baseAddress = bytes.baseAddress else { return }
      compressed.data.copyMemory(from: baseAddress, byteCount: packet.count)
    }
    compressed.byteLength = UInt32(packet.count)
    compressed.packetCount = 1
    if let descriptions = compressed.packetDescriptions {
      descriptions.pointee = AudioStreamPacketDescription(
        mStartOffset: 0,
        mVariableFramesInPacket: UInt32(HuddleAudioFormats.frameSamples),
        mDataByteSize: UInt32(packet.count)
      )
    }

    guard
      let pcm = AVAudioPCMBuffer(
        pcmFormat: pcmFormat,
        frameCapacity: AVAudioFrameCount(HuddleAudioFormats.frameSamples)
      )
    else {
      throw HuddleNativeMediaError.conversion(
        "Unable to allocate the iOS Opus output buffer."
      )
    }
    var suppliedInput = false
    var conversionError: NSError?
    let status = converter.convert(
      to: pcm,
      error: &conversionError
    ) { _, inputStatus in
      guard !suppliedInput else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return compressed
    }
    if status == .error || conversionError != nil || pcm.frameLength == 0 {
      throw HuddleNativeMediaError.conversion(
        conversionError?.localizedDescription ?? "iOS Opus decoding failed."
      )
    }
    return pcm
  }
}

enum HuddleAudioLevels {
  static func rmsDbov(_ samples: [Float]) -> Int {
    guard !samples.isEmpty else { return -127 }
    let squareSum = samples.reduce(0.0) { partial, sample in
      partial + Double(sample * sample)
    }
    let meanSquare = squareSum / Double(samples.count)
    guard meanSquare > 0 else { return -127 }
    return min(0, max(-127, Int((10 * log10(meanSquare)).rounded())))
  }

  static func peakDbov(_ samples: [Float]) -> Int {
    let peak = samples.reduce(Float.zero) { max($0, abs($1)) }
    guard peak > 0 else { return -127 }
    return min(0, max(-127, Int((20 * log10(Double(peak))).rounded())))
  }
}

struct HuddleTalkerSelection: Equatable {
  let accepted: Bool
  let evictedPeerIndex: Int?

  func allocateIfAccepted<T>(_ allocate: () throws -> T) rethrows -> T? {
    guard accepted else { return nil }
    return try allocate()
  }
}

/// Fixed-capacity active-talker selector. The UI roster is independent; native
/// decoder/player resources exist only for peers that actually send packets.
struct HuddleActiveTalkerSelector {
  struct Activity {
    let peerIndex: Int
    let lastPacketOrdinal: UInt64
    let lastPacketAt: TimeInterval
    let levelDbov: Int
  }

  let capacity: Int
  let now: () -> TimeInterval
  let inactivityTimeout: TimeInterval
  private(set) var active: [Int: Activity] = [:]
  private var ordinal: UInt64 = 0

  init(
    capacity: Int,
    now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    inactivityTimeout: TimeInterval = 1
  ) {
    self.capacity = capacity
    self.now = now
    self.inactivityTimeout = inactivityTimeout
  }

  mutating func activate(peerIndex: Int, levelDbov: Int) -> HuddleTalkerSelection {
    ordinal &+= 1
    let packetAt = now()
    if active[peerIndex] != nil {
      active[peerIndex] = Activity(
        peerIndex: peerIndex,
        lastPacketOrdinal: ordinal,
        lastPacketAt: packetAt,
        levelDbov: levelDbov
      )
      return HuddleTalkerSelection(accepted: true, evictedPeerIndex: nil)
    }
    let weakest = active.count >= capacity
      ? active.values.min { left, right in
        if left.levelDbov != right.levelDbov {
          return left.levelDbov < right.levelDbov
        }
        if left.lastPacketOrdinal != right.lastPacketOrdinal {
          return left.lastPacketOrdinal < right.lastPacketOrdinal
        }
        return left.peerIndex < right.peerIndex
      }
      : nil
    let expired = active.values
      .filter { packetAt - $0.lastPacketAt >= inactivityTimeout }
      .min { left, right in
        if left.lastPacketAt != right.lastPacketAt {
          return left.lastPacketAt < right.lastPacketAt
        }
        return left.peerIndex < right.peerIndex
      }
    // Equal-level packets (especially continuous -127 dBov silence) must not
    // churn decoder/jitter state. Admit a new peer when any selected slot is
    // inactive or the new packet is louder than the quietest selected peer.
    if let weakest, expired == nil, levelDbov <= weakest.levelDbov {
      return HuddleTalkerSelection(accepted: false, evictedPeerIndex: nil)
    }
    let evicted = expired?.peerIndex ?? weakest?.peerIndex
    if let evicted { active.removeValue(forKey: evicted) }
    active[peerIndex] = Activity(
      peerIndex: peerIndex,
      lastPacketOrdinal: ordinal,
      lastPacketAt: packetAt,
      levelDbov: levelDbov
    )
    return HuddleTalkerSelection(accepted: true, evictedPeerIndex: evicted)
  }

  mutating func remove(_ peerIndex: Int) {
    active.removeValue(forKey: peerIndex)
  }

  mutating func removeAll() {
    active.removeAll()
    ordinal = 0
  }
}

import AVFoundation
import Foundation

/// Native realtime media engine reused from mobile/ios/Runner (1199b86a67).
///
/// AVAudioEngine owns voice-processed capture and per-peer mixed playout.
/// AVAudioConverter keeps PCM native; NativeHuddle owns background lifetime.
final class HuddleAudioEngine {
  private let onLocalPacket: (HuddleLocalOpusPacket) -> Void
  private let onPCM: ([Float]) -> Void
  private var speechPlayer: AVAudioPlayerNode?
  private let onFailure: (String, String) -> Void
  private let onDiagnostics: (HuddleCaptureDiagnostics) -> Void
  private let diagnosticsEnabled: Bool
  private let audioEngine = AVAudioEngine()
  private let processingQueue = DispatchQueue(
    label: "xyz.block.buzz.huddle.ios-media",
    qos: .userInteractive
  )
  private let stateLock = NSLock()
  private let pcmFormat: AVAudioFormat
  private let encoder: HuddleOpusEncoder

  private var running = false
  private var muted = false
  private var interrupted = false
  private var failureReported = false
  private var pendingCaptureBuffers = 0
  private var pendingRemotePackets = 0
  private var captureConverter: AVAudioConverter?
  private var captureSourceFormat: AVAudioFormat?
  private var captureTapInstalled = false
  private var captureSamples: [Float] = []
  private var captureSampleOffset = 0
  private var sequence = 0
  private var frameIndex: Int64 = 0
  private var diagnosticFrameCount: Int64 = 0
  private var diagnosticMaxPeakDbov = -127
  private var rmsDbovHistogram: [Int: Int64] = [:]
  private var peakDbovHistogram: [Int: Int64] = [:]
  private var peerPlaybacks: [Int: HuddlePeerPlayback] = [:]
  private var activeTalkers = HuddleActiveTalkerSelector(capacity: 15)
  private var playbackTimer: DispatchSourceTimer?
  private var configurationObserver: NSObjectProtocol?

  init(
    onLocalPacket: @escaping (HuddleLocalOpusPacket) -> Void,
    onFailure: @escaping (String, String) -> Void,
    onDiagnostics: @escaping (HuddleCaptureDiagnostics) -> Void,
    diagnosticsEnabled: Bool,
    onPCM: @escaping ([Float]) -> Void = { _ in }
  ) throws {
    pcmFormat = try HuddleAudioFormats.makePCM()
    encoder = try HuddleOpusEncoder()
    self.onLocalPacket = onLocalPacket
    self.onPCM = onPCM
    self.onFailure = onFailure
    self.onDiagnostics = onDiagnostics
    self.diagnosticsEnabled = diagnosticsEnabled
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: audioEngine,
      queue: nil
    ) { [weak self] _ in
      self?.processingQueue.async {
        self?.restartAfterConfigurationChange()
      }
    }
  }

  deinit {
    stop()
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
    }
  }

  static func isSupported() -> Bool {
    do {
      _ = try HuddleOpusEncoder()
      _ = try HuddleOpusDecoder()
      return true
    } catch {
      return false
    }
  }

  func start() throws {
    var startError: Error?
    processingQueue.sync {
      do {
        try startOnQueue()
      } catch {
        startError = error
      }
    }
    if let startError { throw startError }
  }

  func setMuted(_ value: Bool) throws {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard running else {
      throw HuddleNativeMediaError.invalidState(
        "Huddle audio is not running."
      )
    }
    muted = value
  }

  func setOutputMuted(_ value: Bool) {
    processingQueue.async { self.audioEngine.mainMixerNode.outputVolume = value ? 0 : 1 }
  }

  func setInterrupted(_ value: Bool) {
    stateLock.lock()
    let shouldUpdate = running
    interrupted = value
    stateLock.unlock()
    guard shouldUpdate else { return }
    processingQueue.async { [weak self] in
      guard let self else { return }
      if value {
        for playback in peerPlaybacks.values {
          playback.pause()
        }
        return
      }
      do {
        if !audioEngine.isRunning {
          try audioEngine.start()
        }
        for playback in peerPlaybacks.values {
          playback.resume()
        }
      } catch {
        reportFailure(code: "audio_resume_failed", error: error)
      }
    }
  }

  func enqueueRemote(_ packet: HuddleRemoteOpusPacket) throws {
    stateLock.lock()
    guard running else {
      stateLock.unlock()
      throw HuddleNativeMediaError.invalidState(
        "Huddle audio is not running."
      )
    }
    guard pendingRemotePackets < 50 else {
      stateLock.unlock()
      return
    }
    pendingRemotePackets += 1
    stateLock.unlock()
    processingQueue.async { [weak self] in
      guard let self else { return }
      defer { completeRemotePacket() }
      do {
        let selection = activeTalkers.activate(
          peerIndex: packet.peerIndex,
          levelDbov: packet.levelDbov
        )
        if let evictedIndex = selection.evictedPeerIndex,
          let evicted = peerPlaybacks.removeValue(forKey: evictedIndex)
        {
          evicted.release(from: audioEngine)
        }
        let playback: HuddlePeerPlayback
        if let existing = peerPlaybacks[packet.peerIndex] {
          playback = existing
        } else if let allocated = try selection.allocateIfAccepted({
          try HuddlePeerPlayback(
            engine: self.audioEngine,
            pcmFormat: self.pcmFormat
          )
        }) {
          playback = allocated
          peerPlaybacks[packet.peerIndex] = allocated
        } else {
          return
        }
        playback.enqueue(packet)
      } catch {
        reportFailure(code: "playback_failed", error: error)
      }
    }
  }

  private func completeRemotePacket() {
    stateLock.lock()
    pendingRemotePackets = max(0, pendingRemotePackets - 1)
    stateLock.unlock()
  }

  func removeRemotePeer(_ peerIndex: Int) {
    processingQueue.async { [weak self] in
      guard let self else { return }
      activeTalkers.remove(peerIndex)
      guard let playback = peerPlaybacks.removeValue(forKey: peerIndex)
      else { return }
      playback.release(from: audioEngine)
    }
  }

  func stop() {
    processingQueue.sync {
      stopOnQueue()
    }
  }

  private func startOnQueue() throws {
    stateLock.lock()
    let wasRunning = running
    if !wasRunning {
      running = true
      muted = false
      interrupted = false
      failureReported = false
    }
    stateLock.unlock()
    guard !wasRunning else {
      throw HuddleNativeMediaError.invalidState(
        "Huddle audio is already running."
      )
    }

    do {
      // D-029 §1 (audio that survives backgrounding): the call-shaped
      // session. Without an explicit category iOS runs .soloAmbient, which
      // suspends audio the moment the app backgrounds or the screen locks.
      // .playAndRecord + .voiceChat keeps full-duplex alive with the
      // background-audio entitlement (Info.plist UIBackgroundModes).
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.defaultToSpeaker, .allowBluetooth]
      )
      try session.setActive(true)

      let input = audioEngine.inputNode
      try input.setVoiceProcessingEnabled(true)
      let inputFormat = input.outputFormat(forBus: 0)
      guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
        throw HuddleNativeMediaError.unsupported(
          "The iOS microphone does not expose an input format."
        )
      }
      input.installTap(
        onBus: 0,
        bufferSize: AVAudioFrameCount(HuddleAudioFormats.frameSamples),
        format: inputFormat
      ) { [weak self] buffer, _ in
        self?.acceptCapturedBuffer(buffer)
      }
      captureTapInstalled = true
      audioEngine.prepare()
      try audioEngine.start()
      startPlaybackTimer()
      if diagnosticsEnabled {
        onDiagnostics(makeDiagnostics())
      }
    } catch {
      stopOnQueue()
      throw error
    }
  }

  private func stopOnQueue() {
    stateLock.lock()
    running = false
    muted = false
    interrupted = false
    pendingCaptureBuffers = 0
    pendingRemotePackets = 0
    stateLock.unlock()

    playbackTimer?.cancel()
    playbackTimer = nil
    if captureTapInstalled {
      audioEngine.inputNode.removeTap(onBus: 0)
      captureTapInstalled = false
    }
    for playback in peerPlaybacks.values {
      playback.release(from: audioEngine)
    }
    peerPlaybacks.removeAll()
    activeTalkers.removeAll()
    audioEngine.stop()
    audioEngine.reset()
    try? audioEngine.inputNode.setVoiceProcessingEnabled(false)
    captureConverter = nil
    captureSourceFormat = nil
    captureSamples.removeAll(keepingCapacity: false)
    captureSampleOffset = 0
    sequence = 0
    frameIndex = 0
    diagnosticFrameCount = 0
    diagnosticMaxPeakDbov = -127
    rmsDbovHistogram.removeAll()
    peakDbovHistogram.removeAll()
  }

  private func acceptCapturedBuffer(_ buffer: AVAudioPCMBuffer) {
    stateLock.lock()
    guard running, pendingCaptureBuffers < 8 else {
      stateLock.unlock()
      return
    }
    pendingCaptureBuffers += 1
    stateLock.unlock()

    guard let copied = copyPCMBuffer(buffer) else {
      completeCaptureBuffer()
      return
    }
    processingQueue.async { [weak self] in
      guard let self else { return }
      defer { completeCaptureBuffer() }
      do {
        try processCapturedBuffer(copied)
      } catch {
        reportFailure(code: "capture_failed", error: error)
      }
    }
  }

  private func completeCaptureBuffer() {
    stateLock.lock()
    pendingCaptureBuffers = max(0, pendingCaptureBuffers - 1)
    stateLock.unlock()
  }

  private func processCapturedBuffer(_ input: AVAudioPCMBuffer) throws {
    stateLock.lock()
    let isRunning = running
    stateLock.unlock()
    guard isRunning else { return }

    let normalized = try normalizeCapturedBuffer(input)
    guard let channel = normalized.floatChannelData?.pointee else {
      throw HuddleNativeMediaError.conversion(
        "iOS microphone PCM data is unavailable."
      )
    }
    captureSamples.append(
      contentsOf: UnsafeBufferPointer(
        start: channel,
        count: Int(normalized.frameLength)
      )
    )

    while captureSamples.count - captureSampleOffset >= HuddleAudioFormats.frameSamples {
      let end = captureSampleOffset + HuddleAudioFormats.frameSamples
      let frame = Array(captureSamples[captureSampleOffset..<end])
      captureSampleOffset = end
      try processCaptureFrame(frame)
    }
    if captureSampleOffset >= HuddleAudioFormats.frameSamples * 4 {
      captureSamples.removeFirst(captureSampleOffset)
      captureSampleOffset = 0
    }
  }

  private func normalizeCapturedBuffer(
    _ input: AVAudioPCMBuffer
  ) throws -> AVAudioPCMBuffer {
    if matchesTargetPCM(input.format) {
      return input
    }
    if captureSourceFormat?.isEqual(input.format) != true {
      guard let converter = AVAudioConverter(from: input.format, to: pcmFormat) else {
        throw HuddleNativeMediaError.unsupported(
          "iOS cannot convert the active microphone route to Huddle audio."
        )
      }
      converter.primeMethod = .none
      captureConverter = converter
      captureSourceFormat = input.format
    }
    guard let converter = captureConverter else {
      throw HuddleNativeMediaError.conversion(
        "The iOS microphone converter is unavailable."
      )
    }
    let ratio = HuddleAudioFormats.sampleRate / input.format.sampleRate
    let capacity = max(
      HuddleAudioFormats.frameSamples,
      Int(ceil(Double(input.frameLength) * ratio)) + 64
    )
    guard
      let output = AVAudioPCMBuffer(
        pcmFormat: pcmFormat,
        frameCapacity: AVAudioFrameCount(capacity)
      )
    else {
      throw HuddleNativeMediaError.conversion(
        "Unable to allocate converted iOS microphone audio."
      )
    }
    var suppliedInput = false
    var conversionError: NSError?
    let status = converter.convert(
      to: output,
      error: &conversionError
    ) { _, inputStatus in
      guard !suppliedInput else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return input
    }
    if status == .error || conversionError != nil {
      throw HuddleNativeMediaError.conversion(
        conversionError?.localizedDescription
          ?? "iOS microphone conversion failed."
      )
    }
    return output
  }

  private func processCaptureFrame(_ frame: [Float]) throws {
    stateLock.lock()
    let shouldSend = running && !muted && !interrupted
    stateLock.unlock()
    guard shouldSend else { return }
    onPCM(frame)

    let level = HuddleAudioLevels.rmsDbov(frame)
    if diagnosticsEnabled {
      let peak = HuddleAudioLevels.peakDbov(frame)
      diagnosticFrameCount += 1
      diagnosticMaxPeakDbov = max(diagnosticMaxPeakDbov, peak)
      rmsDbovHistogram[level, default: 0] += 1
      peakDbovHistogram[peak, default: 0] += 1
      if diagnosticFrameCount % 50 == 0 {
        onDiagnostics(makeDiagnostics())
      }
    }

    let opus = try encoder.encode(frame)
    let packet = HuddleLocalOpusPacket(
      sequence: sequence,
      timestamp48k: Int(
        UInt32(truncatingIfNeeded: frameIndex * Int64(HuddleAudioFormats.frameSamples))
      ),
      levelDbov: level,
      flags: 0,
      opus: opus
    )
    sequence = (sequence + 1) & 0xffff
    frameIndex += 1
    onLocalPacket(packet)
  }

  private func startPlaybackTimer() {
    let timer = DispatchSource.makeTimerSource(queue: processingQueue)
    timer.schedule(
      deadline: .now() + .milliseconds(20),
      repeating: .milliseconds(20),
      leeway: .milliseconds(2)
    )
    timer.setEventHandler { [weak self] in
      self?.drainPlaybackTick()
    }
    playbackTimer = timer
    timer.resume()
  }

  private func drainPlaybackTick() {
    stateLock.lock()
    let shouldPlay = running && !interrupted
    stateLock.unlock()
    guard shouldPlay else { return }
    do {
      for playback in peerPlaybacks.values {
        try playback.drainOne()
      }
    } catch {
      reportFailure(code: "playback_failed", error: error)
    }
  }

  private func restartAfterConfigurationChange() {
    stateLock.lock()
    let shouldRestart = running && !interrupted
    stateLock.unlock()
    guard shouldRestart else { return }
    do {
      if !audioEngine.isRunning {
        try audioEngine.start()
      }
      for playback in peerPlaybacks.values {
        playback.resume()
      }
    } catch {
      reportFailure(code: "audio_route_failed", error: error)
    }
  }

  private func makeDiagnostics() -> HuddleCaptureDiagnostics {
    let route = AVAudioSession.sharedInstance().currentRoute
    return HuddleCaptureDiagnostics(
      frameCount: diagnosticFrameCount,
      rmsDbovHistogram: numericHistogram(rmsDbovHistogram),
      peakDbovHistogram: numericHistogram(peakDbovHistogram),
      maxPeakDbov: diagnosticMaxPeakDbov,
      deviceLabel: route.inputs.first?.portName,
      voiceProcessingEnabled: audioEngine.inputNode.isVoiceProcessingEnabled
    )
  }

  private func reportFailure(code: String, error: Error) {
    stateLock.lock()
    guard running, !failureReported else {
      stateLock.unlock()
      return
    }
    let message =
      (error as? LocalizedError)?.errorDescription
      ?? error.localizedDescription
    failureReported = true
    stateLock.unlock()
    // Fail closed on the native queue. Flutter will perform the durable session
    // teardown too, but microphone and playout lifetime must not depend on a
    // platform-channel callback making a successful round trip.
    stopOnQueue()
    onFailure(code, message)
  }

  private func matchesTargetPCM(_ format: AVAudioFormat) -> Bool {
    format.commonFormat == .pcmFormatFloat32
      && format.sampleRate == HuddleAudioFormats.sampleRate
      && format.channelCount == HuddleAudioFormats.channels
      && !format.isInterleaved
  }

  private func numericHistogram(_ values: [Int: Int64]) -> [String: Int64] {
    Dictionary(uniqueKeysWithValues: values.map { (String($0.key), $0.value) })
  }

  private func copyPCMBuffer(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard
      let copy = AVAudioPCMBuffer(
        pcmFormat: source.format,
        frameCapacity: source.frameLength
      )
    else { return nil }
    copy.frameLength = source.frameLength
    let sourceBuffers = UnsafeMutableAudioBufferListPointer(
      source.mutableAudioBufferList
    )
    let destinationBuffers = UnsafeMutableAudioBufferListPointer(
      copy.mutableAudioBufferList
    )
    guard sourceBuffers.count == destinationBuffers.count else { return nil }
    for index in sourceBuffers.indices {
      let sourceBuffer = sourceBuffers[index]
      let destinationBuffer = destinationBuffers[index]
      guard
        let sourceData = sourceBuffer.mData,
        let destinationData = destinationBuffer.mData
      else { return nil }
      let byteCount = Int(sourceBuffer.mDataByteSize)
      memcpy(destinationData, sourceData, byteCount)
    }
    return copy
  }
}

private final class HuddlePeerPlayback {
  private let player: AVAudioPlayerNode
  private let decoder: HuddleOpusDecoder
  private var jitterQueue = HuddlePacketJitterQueue(
    capacity: 10,
    startPackets: 3
  )

  init(
    engine: AVAudioEngine,
    pcmFormat: AVAudioFormat
  ) throws {
    decoder = try HuddleOpusDecoder()
    let player = AVAudioPlayerNode()
    self.player = player
    engine.attach(player)
    do {
      engine.connect(player, to: engine.mainMixerNode, format: pcmFormat)
      player.play()
    } catch {
      player.stop()
      engine.disconnectNodeOutput(player)
      engine.detach(player)
      throw error
    }
  }

  func enqueue(_ packet: HuddleRemoteOpusPacket) {
    jitterQueue.enqueue(packet)
  }

  func drainOne() throws {
    guard let packet = jitterQueue.drainOne() else { return }
    let decoded = try decoder.decode(packet.opus)
    player.scheduleBuffer(decoded)
    if !player.isPlaying {
      player.play()
    }
  }

  func pause() {
    if player.isPlaying {
      player.pause()
    }
  }

  func resume() {
    if !player.isPlaying {
      player.play()
    }
  }

  func release(from engine: AVAudioEngine) {
    player.stop()
    engine.disconnectNodeOutput(player)
    engine.detach(player)
    jitterQueue = HuddlePacketJitterQueue(capacity: 10, startPackets: 3)
  }
}

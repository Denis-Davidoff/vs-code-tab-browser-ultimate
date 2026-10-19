// The AI Browser chat's voice messages: records from the microphone and transcribes on the
// device, for the extension host, which has no microphone of its own and whose webview may not
// open one (VS Code grants a webview no `media` permission). See "Voice messages" in CLAUDE.md.
//
//   ai-browser-voice capture <file.m4a> <max seconds> [locale]
//
// One JSON object per line on stdout:
//   {"e":"ready","locale":"ru-RU"}          recording has started
//   {"e":"level","v":0.42,"t":3.25}         the input level, 0…1, and the seconds recorded
//   {"e":"limit","t":300}                   the limit was reached; recording has stopped
//   {"e":"status","v":"transcribing"}       or "downloading": the language's model, once
//   {"e":"text","v":"…","t":12.3}           the transcript; the process then exits 0
//   {"e":"error","code":"…","message":"…"}  then exits 1
// One word per line on stdin: `stop` ends the recording and transcribes it; `cancel`, or stdin
// closing, ends it and removes the file.
//
// Built by scripts/build-voice-helper.mjs. macOS 26 or later: SpeechAnalyzer is new there, and
// unlike SFSpeechRecognizer it needs neither Dictation switched on nor a speech-recognition
// permission, which VS Code's Info.plist does not declare.
import AVFoundation
import Foundation
import Speech

@MainActor func emit(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
	FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

@MainActor func fail(_ code: String, _ message: String) -> Never {
	emit(["e": "error", "code": code, "message": message])
	exit(1)
}

/** The transcriber for `locale`: SpeechTranscriber where it has the language (it punctuates), else DictationTranscriber. */
func transcriber(for wanted: String?) async -> (module: any SpeechModule, locale: Locale, results: () -> AsyncThrowingStream<String, Error>)? {
	let candidates: [Locale] = wanted.flatMap { $0.isEmpty ? nil : [Locale(identifier: $0)] } ?? Locale.preferredLanguages.map { Locale(identifier: $0) } + [Locale.current]
	for candidate in candidates {
		if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) {
			let module = SpeechTranscriber(locale: locale, preset: .transcription)
			return (module, locale, {
				AsyncThrowingStream { continuation in
					Task { do { for try await r in module.results { continuation.yield(String(r.text.characters)) }; continuation.finish() } catch { continuation.finish(throwing: error) } }
				}
			})
		}
		if let locale = await DictationTranscriber.supportedLocale(equivalentTo: candidate) {
			let module = DictationTranscriber(locale: locale, preset: .longDictation)
			return (module, locale, {
				AsyncThrowingStream { continuation in
					Task { do { for try await r in module.results { continuation.yield(String(r.text.characters)) }; continuation.finish() } catch { continuation.finish(throwing: error) } }
				}
			})
		}
	}
	return nil
}

@MainActor final class Capture {
	let engine = AVAudioEngine()
	let url: URL
	let maxSeconds: Double
	var file: AVAudioFile?
	var frames: AVAudioFramePosition = 0
	var rate: Double = 48000
	var recording = false
	var lastLevel = Date.distantPast

	init(url: URL, maxSeconds: Double) { self.url = url; self.maxSeconds = maxSeconds }

	var seconds: Double { Double(frames) / rate }

	func start() throws {
		let input = engine.inputNode
		let format = input.outputFormat(forBus: 0)
		guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."]) }
		rate = format.sampleRate
		// Channel 0 only, in AAC: a meeting room's multi-channel device would not fit an AAC file,
		// and five minutes of float PCM is 57 MB where this is about 2.
		let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000]
		let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
		self.file = file
		let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
		input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
			guard let source = buffer.floatChannelData?[0], let copy = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return }
			copy.frameLength = buffer.frameLength
			memcpy(copy.floatChannelData![0], source, Int(buffer.frameLength) * MemoryLayout<Float>.size)
			var sum: Float = 0
			for i in 0..<Int(buffer.frameLength) { sum += source[i] * source[i] }
			let rms = buffer.frameLength > 0 ? sqrt(sum / Float(buffer.frameLength)) : 0
			Task { @MainActor in self.write(copy, rms: rms) }
		}
		engine.prepare()
		try engine.start()
		recording = true
	}

	func write(_ buffer: AVAudioPCMBuffer, rms: Float) {
		guard recording, let file else { return }
		do { try file.write(from: buffer) } catch { fail("write", error.localizedDescription) }
		frames += AVAudioFramePosition(buffer.frameLength)
		let now = Date()
		if now.timeIntervalSince(lastLevel) >= 0.04 {
			lastLevel = now
			let db = 20 * log10(max(rms, 0.000_01))
			emit(["e": "level", "v": (Double(max(-60, min(0, db))) + 60) / 60, "t": (seconds * 100).rounded() / 100])
		}
		if seconds >= maxSeconds {
			stop()
			emit(["e": "limit", "t": (seconds * 100).rounded() / 100])
		}
	}

	func stop() {
		guard recording else { return }
		recording = false
		engine.inputNode.removeTap(onBus: 0)
		engine.stop()
		file = nil // closes and finishes the file
	}
}

@main struct Voice {
	static func main() async {
		let args = CommandLine.arguments
		guard args.count >= 4, args[1] == "capture", let maxSeconds = Double(args[3]), maxSeconds > 0 else {
			await fail("usage", "ai-browser-voice capture <file.m4a> <max seconds> [locale]")
		}
		let url = URL(fileURLWithPath: args[2])
		let wanted = args.count > 4 ? args[4] : nil

		switch AVCaptureDevice.authorizationStatus(for: .audio) {
		case .authorized: break
		case .notDetermined:
			if !(await AVCaptureDevice.requestAccess(for: .audio)) { await fail("denied", "Microphone access was not allowed.") }
		default:
			await fail("denied", "Microphone access is turned off for this app.")
		}

		guard let speech = await transcriber(for: wanted) else {
			await fail("locale", "On-device transcription has no model for \(wanted ?? Locale.preferredLanguages.first ?? "this language").")
		}
		// The language's model is fetched while the user speaks, so it is usually there by the end.
		let assets = Task { () throws -> Bool in
			if let request = try await AssetInventory.assetInstallationRequest(supporting: [speech.module]) {
				await emit(["e": "status", "v": "downloading"])
				try await request.downloadAndInstall()
				return true
			}
			return false
		}

		let capture = await Capture(url: url, maxSeconds: maxSeconds)
		do { try await capture.start() } catch { await fail("input", error.localizedDescription) }
		await emit(["e": "ready", "locale": speech.locale.identifier(.bcp47)])

		// stdin: the user's decision. EOF is a cancel, so a host that goes away leaves no recording behind.
		// Read off the main actor: a blocking readLine there would stop the writes queued on it.
		let command = await Task.detached { () -> String in
			while let line = readLine(strippingNewline: true) {
				let word = line.trimmingCharacters(in: .whitespaces)
				if word == "stop" || word == "cancel" { return word }
			}
			return "cancel"
		}.value
		await capture.stop()
		if command != "stop" {
			try? FileManager.default.removeItem(at: url)
			exit(0)
		}
		let seconds = await capture.seconds
		do {
			_ = try await assets.value
			await emit(["e": "status", "v": "transcribing"])
			let analyzer = SpeechAnalyzer(modules: [speech.module])
			let audio = try AVAudioFile(forReading: url)
			let collect = Task { () throws -> String in
				var text = ""
				for try await part in speech.results() { text += part }
				return text
			}
			if let last = try await analyzer.analyzeSequence(from: audio) {
				try await analyzer.finalizeAndFinish(through: last)
			} else {
				await analyzer.cancelAndFinishNow()
			}
			let text = try await collect.value.trimmingCharacters(in: .whitespacesAndNewlines)
			await emit(["e": "text", "v": text, "t": (seconds * 100).rounded() / 100])
			exit(0)
		} catch {
			await fail("transcribe", error.localizedDescription)
		}
	}
}

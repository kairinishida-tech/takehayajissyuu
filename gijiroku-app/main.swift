// Gijiroku — メニューバーから Zoom 会議の録音・文字起こし・要約を操作する
// 録音と文字起こしの本体は ~/Documents/gijiroku_tool/gijiroku（Python）で、このアプリはそれを
// `--events start` で起動し、標準出力に流れてくる JSON Lines を表示する。
import AppKit
import AVFoundation
import SwiftUI
import Carbon

// MARK: - 設定

let toolDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/gijiroku_tool", isDirectory: true)
let enginePath = toolDir.appendingPathComponent("gijiroku").path
let stateFile = toolDir.appendingPathComponent(".gijiroku_state.json")
let minutesRoot = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Desktop/議事録", isDirectory: true)

let logFile = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Gijiroku.log")

/// 動作ログ（うまく動かないときの調査用）を ~/Library/Logs/Gijiroku.log に追記する
func appLog(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    if let h = try? FileHandle(forWritingTo: logFile) {
        h.seekToEndOfFile()
        h.write(Data(line.utf8))
        try? h.close()
    } else {
        try? line.write(to: logFile, atomically: true, encoding: .utf8)
    }
}

func elapsedText(_ seconds: Int) -> String {
    seconds >= 3600
        ? String(format: "%d:%02d:%02d", seconds / 3600, seconds % 3600 / 60, seconds % 60)
        : String(format: "%d:%02d", seconds / 60, seconds % 60)
}

/// ターミナルの `gijiroku start` で録音中なら、そのプロセス ID を返す
func externalRecordingPID() -> pid_t? {
    guard let data = try? Data(contentsOf: stateFile),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pid = obj["pid"] as? Int, kill(pid_t(pid), 0) == 0 else { return nil }
    return pid_t(pid)
}

// MARK: - モデル

struct TranscriptLine: Identifiable {
    let id = UUID()
    let time: String
    let speaker: String
    let text: String

    init(_ raw: String) {
        // "[00:12:30] 相手: 本文" を分解する
        var rest = Substring(raw)
        if rest.hasPrefix("["), let close = rest.firstIndex(of: "]") {
            time = String(rest[rest.index(after: rest.startIndex)..<close])
            rest = rest[rest.index(after: close)...].drop(while: { $0 == " " })
        } else {
            time = ""
        }
        if let colon = rest.firstIndex(of: ":"), ["相手", "自分"].contains(String(rest[..<colon])) {
            speaker = String(rest[..<colon])
            text = rest[rest.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        } else {
            speaker = ""
            text = String(rest)
        }
    }
}

enum Phase: Equatable {
    case idle, starting, recording, transcribing, summarizing, done, failed, external

    var busy: Bool { [.starting, .recording, .transcribing, .summarizing, .external].contains(self) }
}

final class Recorder: ObservableObject {
    @Published var phase: Phase = .idle
    @Published var lines: [TranscriptLine] = []
    @Published var summary = ""
    @Published var status = "⌃⌥R またはメニューバーのアイコンをクリックで録音を開始します"
    @Published var elapsed = 0
    @Published var minutesPath: String?
    @Published var tab = 0  // 0 = 文字起こし, 1 = 議事録
    var onChange: (() -> Void)?

    private var process: Process?
    private var startedAt: Date?
    private var timer: Timer?

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        if let start = startedAt, phase == .recording { elapsed = Int(Date().timeIntervalSince(start)) }
        // ターミナルから録音しているときもメニューバーに出す
        if process == nil {
            let ext = externalRecordingPID() != nil
            if ext && phase != .external { phase = .external; status = "ターミナルの gijiroku で録音中です" }
            if !ext && phase == .external { phase = .idle; status = "ターミナルでの録音が終わりました" }
        }
        onChange?()
    }

    func toggle() {
        appLog("toggle phase=\(phase)")
        switch phase {
        case .recording, .starting: stop()
        case .external:
            if let pid = externalRecordingPID() { kill(pid, SIGINT); status = "ターミナルの録音を停止しました。要約はターミナル側で進みます" }
        case .transcribing, .summarizing: break  // 仕上げ中は何もしない
        default: start()
        }
    }

    func start() {
        guard FileManager.default.isExecutableFile(atPath: enginePath) else {
            appLog("engine not executable: \(enginePath)")
            phase = .failed
            status = "⚠️ \(enginePath) が見つかりません。gijiroku_tool の setup.sh を実行してください"
            return
        }
        lines = []
        summary = ""
        minutesPath = nil
        elapsed = 0
        tab = 0
        startedAt = nil
        phase = .starting
        status = "録音の準備中…"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: enginePath)
        p.arguments = ["--events", "start"]
        p.currentDirectoryURL = toolDir
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        env["PYTHONUNBUFFERED"] = "1"
        p.environment = env

        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        var buffer = Data()
        var stderrText = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.handle(obj) }
            }
        }
        err.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            stderrText += String(data: chunk, encoding: .utf8) ?? ""
        }
        p.terminationHandler = { [weak self] proc in
            appLog("engine exited status=\(proc.terminationStatus) stderr=\(stderrText.suffix(500))")
            DispatchQueue.main.async {
                guard let self, self.process === proc else { return }
                self.process = nil
                if self.phase != .done && self.phase != .failed {
                    self.phase = .failed
                    let detail = stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.status = "⚠️ 録音が終了しました" + (detail.isEmpty ? "（終了コード \(proc.terminationStatus)）" : ": \(detail)")
                }
                self.onChange?()
            }
        }
        do {
            try p.run()
            process = p
            appLog("engine started pid=\(p.processIdentifier)")
        } catch {
            appLog("engine launch failed: \(error)")
            phase = .failed
            status = "⚠️ 起動できませんでした: \(error.localizedDescription)"
        }
        onChange?()
    }

    func stop() {
        guard let p = process, phase == .recording || phase == .starting else { return }
        p.interrupt()  // Ctrl+C と同じ。残りの文字起こしと要約まで済ませてから終わる
        phase = .transcribing
        status = "録音を停止しました。残りを文字起こししています…"
        onChange?()
    }

    /// 仕上げ中でも中断して終わる（2回目の Ctrl+C と同じ）
    func abort() {
        process?.interrupt()
        process?.interrupt()
    }

    var isRunning: Bool { process != nil }

    private func handle(_ obj: [String: Any]) {
        let text = obj["text"] as? String ?? ""
        if let kind = obj["type"] as? String, kind != "summary", kind != "line" { appLog("event \(kind) \(text)") }
        switch obj["type"] as? String {
        case "started":
            phase = .recording
            startedAt = Date()
            status = "録音中（\(obj["source"] as? String ?? "")）"
        case "line":
            lines.append(TranscriptLine(text))
        case "phase":
            switch obj["phase"] as? String {
            case "transcribing": phase = .transcribing; status = "残りを文字起こししています…"
            case "summarizing": phase = .summarizing; status = "Claude が要約しています…"; tab = 1
            default: break
            }
        case "summary":
            summary += text
        case "status":
            if text.hasPrefix("!") || text.hasPrefix("（") { status = text.trimmingCharacters(in: CharacterSet(charactersIn: "! ")) }
        case "done":
            phase = .done
            minutesPath = obj["minutes"] as? String
            if let path = minutesPath, summary.isEmpty, let saved = try? String(contentsOfFile: path, encoding: .utf8) {
                summary = saved  // 要約に失敗したときは、保存した議事録（文字起こしのみ）を表示する
            }
            if minutesPath == nil {
                status = "発言が文字起こしされなかったので、議事録は作りませんでした"
            } else if status.contains("ログイン") || status.contains("要約を作れ") {
                // 要約失敗のメッセージはそのまま残す
            } else {
                status = "✅ 議事録を保存しました"
            }
            if minutesPath != nil { tab = 1 }
        case "error":
            phase = .failed
            status = "⚠️ " + text
        default:
            break
        }
        onChange?()
    }
}

// MARK: - UI

struct ContentView: View {
    @ObservedObject var r: Recorder

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Picker("", selection: $r.tab) {
                Text("文字起こし").tag(0)
                Text("議事録").tag(1)
            }
            .pickerStyle(.segmented).labelsHidden()
            if r.tab == 0 { transcriptView } else { summaryView }
            footer
        }
        .padding(12)
        .frame(minWidth: 380, minHeight: 420)
    }

    var header: some View {
        HStack(spacing: 12) {
            Button(action: { r.toggle() }) {
                ZStack {
                    Circle().fill(r.phase == .recording ? Color.red : Color.red.opacity(0.12)).frame(width: 46, height: 46)
                    Image(systemName: r.phase == .recording || r.phase == .external ? "stop.fill" : "mic.fill")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(r.phase == .recording ? Color.white : Color.red)
                }
            }
            .buttonStyle(.plain)
            .disabled(r.phase == .transcribing || r.phase == .summarizing)
            .help(r.phase == .recording ? "録音を停止（⌃⌥R）" : "録音を開始（⌃⌥R）")

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.system(size: 15, weight: .bold))
                    if r.phase == .recording {
                        Text(elapsedText(r.elapsed)).font(.system(size: 15, weight: .semibold).monospacedDigit())
                            .foregroundStyle(.red)
                    }
                    if r.phase == .transcribing || r.phase == .summarizing || r.phase == .starting {
                        ProgressView().controlSize(.small)
                    }
                }
                Text(r.status).font(.caption).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
            }
            Spacer()
            Text("⌃⌥R").font(.caption.monospaced()).foregroundStyle(.secondary)
        }
        .padding(10)
        .background((r.phase == .recording ? Color.red : Color.gray).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .animation(.easeInOut(duration: 0.2), value: r.phase)
    }

    var title: String {
        switch r.phase {
        case .idle: return "待機中"
        case .starting: return "準備中"
        case .recording: return "録音中"
        case .transcribing: return "文字起こし中"
        case .summarizing: return "要約中"
        case .done: return "完了"
        case .failed: return "エラー"
        case .external: return "ターミナルで録音中"
        }
    }

    var transcriptView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if r.lines.isEmpty {
                        Text(r.phase == .recording ? "約30秒ごとに、ここへ文字起こしが追加されます" : "まだ文字起こしはありません")
                            .font(.callout).foregroundStyle(.secondary).padding(.top, 8)
                    }
                    ForEach(r.lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(line.time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                            if !line.speaker.isEmpty {
                                Text(line.speaker)
                                    .font(.caption.bold())
                                    .padding(.horizontal, 6).padding(.vertical, 1)
                                    .background(Capsule().fill(line.speaker == "相手" ? Color.blue.opacity(0.18) : Color.green.opacity(0.2)))
                                    .foregroundStyle(line.speaker == "相手" ? Color.blue : Color.green)
                            }
                            Text(line.text).font(.system(size: 13)).textSelection(.enabled)
                        }
                        .id(line.id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }
            .onChange(of: r.lines.count) {
                if let last = r.lines.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    var summaryView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(r.summary.isEmpty ? "録音を停止すると、Claude がここに議事録を書きます" : markdown(r.summary))
                    .font(.system(size: 13))
                    .foregroundStyle(r.summary.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                Color.clear.frame(height: 1).id("bottom")
            }
            .onChange(of: r.summary) { if r.phase == .summarizing { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    var footer: some View {
        HStack {
            Button {
                if let path = r.minutesPath { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
            } label: { Label("議事録を開く", systemImage: "doc.text") }
            .disabled(r.minutesPath == nil)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(r.summary, forType: .string)
            } label: { Label("コピー", systemImage: "doc.on.doc") }
            .disabled(r.summary.isEmpty)
            Spacer()
            Button {
                try? FileManager.default.createDirectory(at: minutesRoot, withIntermediateDirectories: true)
                NSWorkspace.shared.open(minutesRoot)
            } label: { Label("議事録フォルダ", systemImage: "folder") }
        }
        .controlSize(.small)
    }

    func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

// MARK: - 開始・停止の表示用 HUD

struct HUDView: View {
    let recording: Bool
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: recording ? "record.circle.fill" : "stop.circle.fill")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(recording ? Color.red : Color.white.opacity(0.85))
            Text(recording ? "録音開始" : "録音停止 — 議事録を作ります")
                .font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
        }
        .padding(.horizontal, 22).padding(.vertical, 14)
        .background(Capsule().fill(Color.black.opacity(0.75)))
        .fixedSize()
    }
}

final class HUD {
    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?

    func show(recording: Bool) {
        hideWork?.cancel()
        panel?.orderOut(nil)
        let host = NSHostingView(rootView: HUDView(recording: recording))
        let size = host.fittingSize
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.level = .statusBar
        p.ignoresMouseEvents = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.contentView = host
        if let f = NSScreen.main?.visibleFrame {
            p.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.minY + f.height * 0.2))
        }
        p.alphaValue = 1
        p.orderFrontRegardless()
        panel = p
        let work = DispatchWorkItem { [weak p] in
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; p?.animator().alphaValue = 0 },
                                                  completionHandler: { p?.orderOut(nil) })
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }
}

// MARK: - アプリ

// 手前にないウィンドウでも、1回目のクリックでボタンが反応するようにする
// （標準のままだと、最初のクリックはウィンドウを前に出すだけで録音ボタンに届かない）
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// 黄色ボタン（最小化）で Dock に入れず、画面から隠すだけにするパネル
final class GijirokuPanel: NSPanel {
    override func miniaturize(_ sender: Any?) { orderOut(sender) }
    override func performMiniaturize(_ sender: Any?) { orderOut(sender) }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let recorder = Recorder()
    let hud = HUD()
    var panel: GijirokuPanel!
    var statusItem: NSStatusItem!
    var menu = NSMenu()
    var recordHotKeyRef: EventHotKeyRef?
    var panelHotKeyRef: EventHotKeyRef?
    var lastPhase: Phase = .idle

    func applicationDidFinishLaunching(_ note: Notification) {
        panel = GijirokuPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 520),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        panel.title = "議事録"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.contentView = FirstMouseHostingView(rootView: ContentView(r: recorder))
        panel.setFrameAutosaveName("GijirokuPanel")
        if !panel.setFrameUsingName("GijirokuPanel"), let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.maxX - 440, y: f.maxY - 540))
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        recorder.onChange = { [weak self] in self?.recorderChanged() }
        registerHotKeys()
        updateStatusItem()
        // ショートカット.app などからも開始・停止できるように（例: 通知 local.gijiroku.toggle を送る）
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("local.gijiroku.toggle"),
                                                            object: nil, queue: .main) { [weak self] _ in
            self?.toggleRecording()
        }
        appLog("launched")

        // 最初にマイクの使用許可を取っておく（録音する ffmpeg はこのアプリの権限で動く）
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        panel.orderFrontRegardless()
    }

    func recorderChanged() {
        let phase = recorder.phase
        if phase != lastPhase {
            if phase == .recording { hud.show(recording: true) }
            if lastPhase == .recording && phase == .transcribing { hud.show(recording: false) }
            if phase == .done || phase == .failed { panel.orderFrontRegardless() }
            lastPhase = phase
        }
        updateStatusItem()
    }

    func updateStatusItem() {
        guard let button = statusItem.button else { return }
        let symbol: String, color: NSColor, title: String
        switch recorder.phase {
        case .recording: symbol = "record.circle.fill"; color = .systemRed; title = " " + elapsedText(recorder.elapsed)
        case .starting: symbol = "record.circle"; color = .systemRed; title = " 準備中"
        case .external: symbol = "record.circle.fill"; color = .systemRed; title = " 録音中"
        case .transcribing: symbol = "text.bubble"; color = .systemOrange; title = " 文字起こし中"
        case .summarizing: symbol = "sparkles"; color = .systemOrange; title = " 要約中"
        case .failed: symbol = "exclamationmark.triangle"; color = .systemYellow; title = ""
        default: symbol = "mic"; color = .labelColor; title = ""
        }
        let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
            .applying(.init(paletteColors: [color]))
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "議事録")?.withSymbolConfiguration(config)
        img?.isTemplate = recorder.phase == .idle || recorder.phase == .done
        button.image = img
        button.imagePosition = .imageLeading
        button.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold),
            .foregroundColor: color,
        ])
        button.toolTip = "クリックで録音の開始・停止（⌃⌥R）\n⌃⌥G でウィンドウ表示/非表示\n右クリックでメニュー"
    }

    // 左クリック = 録音の開始・停止、右クリック（または ⌃/⌥ クリック）= メニュー
    @objc func statusClicked() {
        guard let ev = NSApp.currentEvent else { return }
        appLog("status item clicked type=\(ev.type.rawValue)")
        if ev.type == .rightMouseUp || !ev.modifierFlags.intersection([.control, .option]).isEmpty {
            rebuildMenu()
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else {
            toggleRecording()
        }
    }

    func registerHotKeys() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let userData, let event else { return noErr }
            let me = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            DispatchQueue.main.async { hk.id == 2 ? me.togglePanel() : me.toggleRecording() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        // ⌃⌥R = 録音の開始・停止、⌃⌥G = ウィンドウ表示/非表示
        RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x47494A49), id: 1),
                            GetApplicationEventTarget(), 0, &recordHotKeyRef)
        RegisterEventHotKey(UInt32(kVK_ANSI_G), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x47494A49), id: 2),
                            GetApplicationEventTarget(), 0, &panelHotKeyRef)
    }

    func rebuildMenu() {
        let m = NSMenu()
        let title: String
        switch recorder.phase {
        case .recording, .starting: title = "録音を停止　⌃⌥R"
        case .external: title = "ターミナルの録音を停止　⌃⌥R"
        case .transcribing, .summarizing: title = "議事録を作成中…"
        default: title = "録音を開始　⌃⌥R"
        }
        let rec = NSMenuItem(title: title, action: #selector(toggleRecording), keyEquivalent: "")
        rec.isEnabled = !(recorder.phase == .transcribing || recorder.phase == .summarizing)
        m.addItem(rec)
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: panel.isVisible ? "ウィンドウを隠す　⌃⌥G" : "ウィンドウを表示　⌃⌥G",
                             action: #selector(togglePanel), keyEquivalent: ""))
        let open = NSMenuItem(title: "今回の議事録を開く", action: #selector(openMinutes), keyEquivalent: "")
        open.isEnabled = recorder.minutesPath != nil
        m.addItem(open)
        m.addItem(NSMenuItem(title: "議事録フォルダを開く", action: #selector(openMinutesFolder), keyEquivalent: ""))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "終了", action: #selector(quit), keyEquivalent: "q"))
        m.items.forEach { if $0.action != nil { $0.target = self } }
        menu = m
    }

    @objc func toggleRecording() { recorder.toggle() }
    @objc func togglePanel() { panel.isVisible ? panel.orderOut(nil) : panel.orderFrontRegardless() }
    @objc func openMinutes() { if let p = recorder.minutesPath { NSWorkspace.shared.open(URL(fileURLWithPath: p)) } }
    @objc func openMinutesFolder() {
        try? FileManager.default.createDirectory(at: minutesRoot, withIntermediateDirectories: true)
        NSWorkspace.shared.open(minutesRoot)
    }

    @objc func quit() {
        guard recorder.isRunning else { NSApp.terminate(nil); return }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = recorder.phase == .recording ? "録音中です" : "議事録を作成中です"
        alert.informativeText = "録音を止めて、議事録ができるのを待ってから終了します。"
        alert.addButton(withTitle: "止めて終了")
        alert.addButton(withTitle: "キャンセル")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        recorder.stop()
        waitAndQuit()
    }

    private func waitAndQuit() {
        if recorder.isRunning {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.waitAndQuit() }
        } else {
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

// What WindowServer composited, at each refresh (spec 28 A2.10 (A3), A3.8 #34-#37, #50): a ScreenCaptureKit stream of
// one window, or of a display, sampled at the regions a case names and written as JSON lines. Tests only: the app
// itself never asks for Screen Recording (A2.12).
//
//   capture check                                   {"access":…,"locked":…,"asleep":…}; exit 0, or 77 when blind
//   capture window --window-id <CGWindowID> [--regions 'name:x,y,w,h;...'] [--grid <cols>x<rows>] [--fps <n>] [--ring x,y,w,h]
//   capture window --pid <pid> [--title <title>]    the same, the window found by its owner (and title)
//   capture display [--display-id <id>] --detect <rrggbb>:<minPx>[:<belowY>] [--heartbeat]
//
// stdout, one JSON object a line (app/test/harness/capture.ts reads it; the shape is frozen there):
//   {"ready":{"hostNs":"…","refreshHz":120,"scale":2,"window":{"w":…,"h":…}}}   once the stream started
//   {"hostNs":"…","status":"complete|idle|blank|suspended|started|stopped","gap":n?,"regions":{…}?,"detect":{…}?}
// `hostNs` is the frame's display time (SCStreamFrameInfo.displayTime) in ns on mach_continuous_time - the clock main's
// journal stamps with process.hrtime.bigint(). `gap` counts the refreshes missing before a frame (consecutive
// display times more than 1.5 refresh intervals apart): a transition across a gap is inconclusive, never passed.
// A region is sampled on a grid of cell centres, each sample "rrggbb" in sRGB; its coordinates are window points
// from the window's top-left (titleBarStyle 'hidden': the content view is the whole window).
// stdin: a line "png <path>" writes the last complete frame there ({"png":"done"}); "png-at <id> <hostNs> <path>"
// writes the frame displayed at that time from the ring ({"png":"done"|"missing","id":…}): `--ring x,y,w,h` (window
// points) keeps that rect of the last `--ring-frames` (60) complete frames at one pixel a point, so a case can keep
// the frames around its first bad one - the strip, not the window (a 1280 x 44 strip is 225 KB: 240 frames, two
// seconds at 120 Hz, 54 MB). EOF stops the stream.
// `--heartbeat` (display mode): the helper keeps a 2 x 2 px window in the display's bottom-left corner changing at the
// refresh rate, so every refresh has something to capture and a gap means a missed frame - a display stream skips
// the refreshes in which nothing changed (on this Mac, 41 of 136 in 1.5 s, up to 58 ms apart, with no heartbeat).
//
// **Screen Recording is the runner's** (A3.8 #37): without it this exits 77 - "blind", reported as not run, never as
// a pass. The process macOS asks about is the one that started this helper (the terminal or the agent's host). A
// locked screen or a sleeping display is blind the same way (exit 77): WindowServer composites nothing to watch.
import AppKit
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)
let BLIND: Int32 = 77

func fail(_ code: Int32, _ why: String) -> Never {
  FileHandle.standardError.write("capture: \(why)\n".data(using: .utf8)!)
  exit(code)
}

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func ticksToNs(_ t: UInt64) -> UInt64 { t / UInt64(timebase.denom) * UInt64(timebase.numer) + (t % UInt64(timebase.denom)) * UInt64(timebase.numer) / UInt64(timebase.denom) }
/// SCK's display times are mach_absolute_time, which stops while the Mac sleeps; Node's process.hrtime.bigint() (libuv)
/// reads mach_continuous_time, which does not. Every time is written on the continuous clock: the absolute one plus
/// the sleep so far, read now (it changes only across a sleep).
func toNs(_ abs: UInt64) -> UInt64 { ticksToNs(abs &+ (mach_continuous_time() &- mach_absolute_time())) }

// ---- arguments ---------------------------------------------------------------------------------------------------

let args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
guard let mode = args.first else { fail(2, "usage: capture check | window --window-id <id> | window --pid <pid> | display --detect <hex>:<minPx>") }

// Nothing is composited while the screen is locked or the main display asleep: a stream then sends only `idle` frames
// (seen on this Mac, 24 Oct, the lid shut on battery: 212 idle frames in 2 s, none complete). That is blind too.
func screenLocked() -> Bool {
  guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (d["CGSSessionScreenIsLocked"] as? Bool) ?? ((d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false)
}
let displayAsleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0

if mode == "check" {
  let ok = CGPreflightScreenCaptureAccess()
  let locked = screenLocked()
  print("{\"access\":\(ok),\"locked\":\(locked),\"asleep\":\(displayAsleep)}")
  exit(ok && !locked && !displayAsleep ? 0 : BLIND)
}
// never CGRequestScreenCaptureAccess(): a run must not raise the system's question on whoever sits at the Mac
if !CGPreflightScreenCaptureAccess() { fail(BLIND, "blind: Screen Recording is not granted to the process that runs this helper") }
if screenLocked() || displayAsleep { fail(BLIND, "blind: the screen is locked or the display asleep, so nothing is composited") }

struct Region { let name: String; let x: Double; let y: Double; let w: Double; let h: Double }
func parseRegions(_ s: String?) -> [Region] {
  guard let s else { return [] }
  return s.split(separator: ";").compactMap { part in
    let kv = part.split(separator: ":", maxSplits: 1)
    guard kv.count == 2 else { return nil }
    let n = kv[1].split(separator: ",").compactMap { Double($0) }
    guard n.count == 4 else { return nil }
    return Region(name: String(kv[0]), x: n[0], y: n[1], w: n[2], h: n[3])
  }
}
let regions = parseRegions(opt("--regions"))
let gridSpec = (opt("--grid") ?? "4x4").split(separator: "x").compactMap { Int($0) }
let gridCols = max(1, gridSpec.first ?? 4)
let gridRows = max(1, gridSpec.count > 1 ? gridSpec[1] : gridCols)

struct Detect { let r: Int; let g: Int; let b: Int; let minPx: Int; let belowY: Int }
func parseDetect(_ s: String?) -> Detect? {
  guard let s else { return nil }
  let p = s.split(separator: ":")
  guard p.count >= 2, p[0].count == 6, let v = Int(p[0], radix: 16), let m = Int(p[1]) else { return nil }
  return Detect(r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, minPx: m, belowY: p.count > 2 ? Int(p[2]) ?? 0 : 0)
}
let detect = parseDetect(opt("--detect"))
let ringRect: Region? = parseRegions(opt("--ring").map { "ring:" + $0 }).first
let RING = max(1, min(600, opt("--ring-frames").flatMap { Int($0) } ?? 60))

// ---- the stream's output -----------------------------------------------------------------------------------------

func hex(_ p: UnsafePointer<UInt8>) -> String {   // BGRA
  String(format: "%02x%02x%02x", p[2], p[1], p[0])
}

/// One frame of the ring: the `--ring` rect's pixels (BGRA), its display time.
final class Kept { var ns: UInt64 = 0; var w = 0; var h = 0; var bytes: [UInt8] = [] }

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  let intervalNs: Double
  /// window points -> buffer pixels, from the window's size in points (set before the stream starts)
  var sizePt: CGSize
  var lastNs: UInt64 = 0
  var lastBuffer: CVPixelBuffer?
  var lastInfo = ""
  let lock = NSLock()
  /// the ring of the last RING complete frames' `--ring` rect, reused in place (no allocation a frame once full)
  var ring: [Kept] = []
  var ringNext = 0

  init(intervalNs: Double, sizePt: CGSize) { self.intervalNs = intervalNs; self.sizePt = sizePt }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let a = atts.first else { return }
    let raw = a[.status] as? Int ?? -1
    let st = SCFrameStatus(rawValue: raw)
    let status: String
    switch st {
    case .complete: status = "complete"
    case .idle: status = "idle"
    case .blank: status = "blank"
    case .suspended: status = "suspended"
    case .started: status = "started"
    case .stopped: status = "stopped"
    default: status = "unknown"
    }
    let disp = toNs(a[.displayTime] as? UInt64 ?? mach_absolute_time())
    var line = "{\"hostNs\":\"\(disp)\",\"status\":\"\(status)\""
    if lastNs > 0 && disp > lastNs {
      let d = Double(disp - lastNs)
      if d > intervalNs * 1.5 { line += ",\"gap\":\(Int((d / intervalNs).rounded()) - 1)" }
    }
    lastNs = max(lastNs, disp)
    if st == .complete, let px = CMSampleBufferGetImageBuffer(sb) {
      lock.lock(); lastBuffer = px; lock.unlock()
      CVPixelBufferLockBaseAddress(px, .readOnly)
      defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
      let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px), row = CVPixelBufferGetBytesPerRow(px)
      if let base = CVPixelBufferGetBaseAddress(px)?.assumingMemoryBound(to: UInt8.self) {
        // window points -> frame pixels, per frame: (contentRect.origin + p * contentScale) * scaleFactor, the rect in
        // points of the frame (a window resized after the stream started is drawn smaller, or scaled down to fit)
        var ox = 0.0, oy = 0.0
        var sx = Double(w) / max(1, Double(sizePt.width)), sy = Double(h) / max(1, Double(sizePt.height))
        if let d = a[.contentRect], let r = CGRect(dictionaryRepresentation: d as! CFDictionary),
          let cs = a[.contentScale] as? CGFloat, let sf = a[.scaleFactor] as? CGFloat, cs > 0, sf > 0 {
          ox = Double(r.origin.x * sf); oy = Double(r.origin.y * sf)
          sx = Double(cs * sf); sy = Double(cs * sf)
          let info = "\"info\":{\"px\":[\(w),\(h)],\"contentRect\":[\(r.origin.x),\(r.origin.y),\(r.size.width),\(r.size.height)],\"contentScale\":\(cs),\"scaleFactor\":\(sf)}"
          if info != lastInfo { lastInfo = info; line += "," + info }
        }
        if !regions.isEmpty {
          var parts: [String] = []
          for r in regions {
            var samples: [String] = []
            for j in 0..<gridRows {
              for i in 0..<gridCols {
                let x = Int((ox + (r.x + r.w * (Double(i) + 0.5) / Double(gridCols)) * sx).rounded(.down))
                let y = Int((oy + (r.y + r.h * (Double(j) + 0.5) / Double(gridRows)) * sy).rounded(.down))
                if x < 0 || y < 0 || x >= w || y >= h { samples.append("\"\""); continue }
                samples.append("\"\(hex(base + y * row + x * 4))\"")
              }
            }
            parts.append("\"\(r.name)\":[\(samples.joined(separator: ","))]")
          }
          line += ",\"regions\":{\(parts.joined(separator: ","))}"
        }
        if let d = detect { line += ",\"detect\":" + find(d, base, w, h, row, sx, sy) }
        if let rr = ringRect { ringKeep(rr, disp, base, w, h, row, ox, oy, sx, sy) }
      }
    }
    print(line + "}")
  }

  /// A solid block of the sentinel, at least minPx x minPx points, below belowY points: a lattice scan, then a block check.
  func find(_ d: Detect, _ base: UnsafePointer<UInt8>, _ w: Int, _ h: Int, _ row: Int, _ sx: Double, _ sy: Double) -> String {
    let near = { (p: UnsafePointer<UInt8>) -> Bool in abs(Int(p[2]) - d.r) <= 24 && abs(Int(p[1]) - d.g) <= 24 && abs(Int(p[0]) - d.b) <= 24 }
    let bw = Int(Double(d.minPx) * sx), bh = Int(Double(d.minPx) * sy)
    let step = max(4, bw / 4)
    var y = Int(Double(d.belowY) * sy)
    while y + bh <= h {
      var x = 0
      while x + bw <= w {
        if near(base + y * row + x * 4) {
          var hits = 0
          for j in 0..<8 { for i in 0..<8 { if near(base + (y + j * (bh - 1) / 7) * row + (x + i * (bw - 1) / 7) * 4) { hits += 1 } } }
          if hits >= 62 {
            return "{\"found\":true,\"rect\":{\"x\":\(Int(Double(x) / sx)),\"y\":\(Int(Double(y) / sy)),\"w\":\(d.minPx),\"h\":\(d.minPx)}}"
          }
        }
        x += step
      }
      y += step
    }
    return "{\"found\":false}"
  }

  /// The ring rect of this frame, copied row by row into the next slot of the ring.
  func ringKeep(_ r: Region, _ ns: UInt64, _ base: UnsafePointer<UInt8>, _ w: Int, _ h: Int, _ row: Int, _ ox: Double, _ oy: Double, _ sx: Double, _ sy: Double) {
    let x0 = max(0, Int(ox + r.x * sx)), y0 = max(0, Int(oy + r.y * sy))
    let x1 = min(w, Int(ox + (r.x + r.w) * sx)), y1 = min(h, Int(oy + (r.y + r.h) * sy))
    // one pixel a point: every step-th pixel of every step-th row
    let step = max(1, Int(sx.rounded()))
    guard x1 > x0, y1 > y0 else { return }
    let cw = (x1 - x0) / step, ch = (y1 - y0) / step
    guard cw > 0, ch > 0 else { return }
    lock.lock(); defer { lock.unlock() }
    let k: Kept
    if ring.count < RING { k = Kept(); ring.append(k) } else { k = ring[ringNext] }
    ringNext = (ringNext + 1) % RING
    if k.bytes.count != cw * ch * 4 { k.bytes = [UInt8](repeating: 0, count: cw * ch * 4) }
    k.ns = ns; k.w = cw; k.h = ch
    k.bytes.withUnsafeMutableBytes { dst in
      let d = dst.baseAddress!.assumingMemoryBound(to: UInt8.self)
      for yy in 0..<ch {
        let src = base + (y0 + yy * step) * row + x0 * 4
        if step == 1 { memcpy(d + yy * cw * 4, src, cw * 4); continue }
        for xx in 0..<cw { let s = src + xx * step * 4, o = d + (yy * cw + xx) * 4; o[0] = s[0]; o[1] = s[1]; o[2] = s[2]; o[3] = s[3] }
      }
    }
  }

  /// The ring's frame displayed at `ns` (exact, else the last one before it, if the ring still reaches back that far).
  func pngAt(_ ns: UInt64, _ path: String) -> Bool {
    lock.lock()
    let hit = ring.filter { $0.ns > 0 && $0.ns <= ns }.max { $0.ns < $1.ns }
    let oldest = ring.filter { $0.ns > 0 }.map { $0.ns }.min() ?? UInt64.max
    var copy: (w: Int, h: Int, bytes: [UInt8])?
    if let k = hit, ns >= oldest { copy = (k.w, k.h, k.bytes) }
    lock.unlock()
    guard var c = copy else { return false }
    return c.bytes.withUnsafeMutableBytes { buf -> Bool in
      guard let ctx = CGContext(data: buf.baseAddress, width: c.w, height: c.h, bitsPerComponent: 8, bytesPerRow: c.w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
        let img = ctx.makeImage(),
        let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
      CGImageDestinationAddImage(dest, img, nil)
      return CGImageDestinationFinalize(dest)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail(4, "the stream stopped: \(error.localizedDescription)")
  }

  func png(_ path: String) {
    lock.lock(); let px = lastBuffer; lock.unlock()
    guard let px else { return }
    let ci = CIImage(cvPixelBuffer: px)
    guard let cg = CIContext().createCGImage(ci, from: ci.extent),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
  }
}

// ---- the display a window is on, and its rate ------------------------------------------------------------------

func screenFor(_ frame: CGRect) -> (hz: Int, scale: Double) {
  // SCWindow frames are in the global top-left space; NSScreen frames are bottom-left, the main screen at the origin
  let mainH = NSScreen.screens.first?.frame.height ?? 0
  let c = CGPoint(x: frame.midX, y: mainH - frame.midY)
  let s = NSScreen.screens.first { $0.frame.contains(c) } ?? NSScreen.main
  return (s?.maximumFramesPerSecond ?? 60, Double(s?.backingScaleFactor ?? 2))
}

// ---- run -------------------------------------------------------------------------------------------------------

var keep: (SCStream, Output)?

func start() async throws {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
  let filter: SCContentFilter
  let cfg = SCStreamConfiguration()
  var hz = 60
  var scale = 2.0
  var size = CGSize.zero
  if mode == "window" {
    var win: SCWindow?
    if let s = opt("--window-id"), let id = UInt32(s) { win = content.windows.first { $0.windowID == id } }
    else if let s = opt("--pid"), let pid = Int32(s) {
      let title = opt("--title")
      win = content.windows.first { $0.owningApplication?.processID == pid && (title == nil || $0.title == title) && $0.frame.width > 100 }
    }
    guard let w = win else { fail(3, "no such window") }
    (hz, scale) = screenFor(w.frame)
    size = w.frame.size
    filter = SCContentFilter(desktopIndependentWindow: w)
    cfg.width = Int(size.width * scale)
    cfg.height = Int(size.height * scale)
    cfg.ignoreShadowsSingleWindow = true
  } else if mode == "display" {
    let id = opt("--display-id").flatMap { UInt32($0) }
    guard let d = content.displays.first(where: { id == nil ? $0.displayID == CGMainDisplayID() : $0.displayID == id }) else { fail(3, "no such display") }
    (hz, scale) = screenFor(d.frame)
    size = d.frame.size
    filter = SCContentFilter(display: d, excludingWindows: [])
    // one pixel a point: the sentinel block is large, and a 1x stream keeps the scan cheap
    cfg.width = Int(size.width)
    cfg.height = Int(size.height)
  } else { fail(2, "unknown mode \(mode)") }
  if let f = opt("--fps").flatMap({ Int($0) }) { hz = f }
  if mode == "display" && args.contains("--heartbeat") {
    let id = opt("--display-id").flatMap { UInt32($0) } ?? CGMainDisplayID()
    let hzNow = hz
    DispatchQueue.main.async { startHeartbeat(display: id, hz: hzNow) }
  }
  cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(hz))
  cfg.queueDepth = 8
  cfg.pixelFormat = kCVPixelFormatType_32BGRA
  cfg.colorSpaceName = CGColorSpace.sRGB
  cfg.showsCursor = false
  let out = Output(intervalNs: 1e9 / Double(hz), sizePt: size)
  let stream = SCStream(filter: filter, configuration: cfg, delegate: out)
  try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.frames", qos: .userInteractive))
  try await stream.startCapture()
  keep = (stream, out)
  print("{\"ready\":{\"hostNs\":\"\(toNs(mach_absolute_time()))\",\"refreshHz\":\(hz),\"scale\":\(scale),\"window\":{\"w\":\(Int(size.width)),\"h\":\(Int(size.height))}}}")
}

/// The heartbeat: a borderless 2 x 2 window above everything, ignoring the mouse, toggled at the refresh rate.
var heartbeat: NSWindow?
func startHeartbeat(display: CGDirectDisplayID, hz: Int) {
  let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display } ?? NSScreen.main
  guard let s = screen else { return }
  let w = NSWindow(contentRect: NSRect(x: s.frame.minX, y: s.frame.minY, width: 2, height: 2), styleMask: .borderless, backing: .buffered, defer: false)
  w.level = .screenSaver
  w.ignoresMouseEvents = true
  w.isOpaque = true
  w.hasShadow = false
  w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
  w.backgroundColor = .black
  w.orderFrontRegardless()
  heartbeat = w
  var on = false
  let t = Timer(timeInterval: 1.0 / Double(max(30, hz)), repeats: true) { _ in on.toggle(); w.backgroundColor = on ? NSColor(white: 0.2, alpha: 1) : .black }
  RunLoop.main.add(t, forMode: .common)
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
Thread.detachNewThread {
  while let l = readLine() {
    if l.hasPrefix("png-at ") {
      let p = l.split(separator: " ", maxSplits: 3).map(String.init)
      let ok = p.count == 4 && UInt64(p[2]) != nil && (keep?.1.pngAt(UInt64(p[2])!, p[3]) ?? false)
      print("{\"png\":\"\(ok ? "done" : "missing")\",\"id\":\"\(p.count > 1 ? p[1] : "")\"}")
    } else if l.hasPrefix("png "), let k = keep { k.1.png(String(l.dropFirst(4))) ; print("{\"png\":\"done\"}") }
  }
  if let k = keep { k.0.stopCapture { _ in exit(0) } } else { exit(0) }
}
Task {
  do { try await start() } catch { fail(4, "\(error.localizedDescription)") }
}
// the main run loop (not only the main queue): the heartbeat's window and timer live on it
NSApplication.shared.setActivationPolicy(.accessory)
RunLoop.main.run()

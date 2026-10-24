// Posts real mouse events to one process (spec 28 A3.8 #38, S13's gap): a click, a drag or a scroll at a point on
// the screen, as CGEvents posted to the app's pid alone (CGEventPostToPid), never to whatever app is in front and
// never moving the person's cursor. Beside keypost.swift.
//
//   clickpost check                                   "access: true|false" (CGPreflightPostEventAccess), exit 0
//   clickpost click <pid> <x> <y>                      left down and up at a global point (top-left origin, points)
//   clickpost drag <pid> <x0> <y0> <x1> <y1> [steps]   left down at the first point, dragged to the second, up
//   clickpost scroll <pid> <x> <y> <dx> <dy>           one pixel-unit scroll wheel event at the point
//
// The terminal running it needs Accessibility (System Settings > Privacy & Security); without it macOS drops the
// events silently, which is why every click case starts with its control case (the same click at y 100 reaches the
// page) and is inconclusive when that fails.
import ApplicationServices
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "check" {
  print("access: \(CGPreflightPostEventAccess())")
  exit(0)
}
func usage() -> Never {
  FileHandle.standardError.write("usage: clickpost check | click <pid> <x> <y> | drag <pid> <x0> <y0> <x1> <y1> [steps] | scroll <pid> <x> <y> <dx> <dy>\n".data(using: .utf8)!)
  exit(2)
}
guard args.count >= 4, let pid = pid_t(args[1]) else { usage() }
let n = args.dropFirst(2).compactMap { Double($0) }
let src = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
  guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { exit(1) }
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.postToPid(pid)
}

switch args[0] {
case "click":
  guard n.count >= 2 else { usage() }
  let p = CGPoint(x: n[0], y: n[1])
  post(.mouseMoved, p)
  usleep(20_000)
  post(.leftMouseDown, p)
  usleep(40_000)
  post(.leftMouseUp, p)
case "drag":
  guard n.count >= 4 else { usage() }
  let a = CGPoint(x: n[0], y: n[1]), b = CGPoint(x: n[2], y: n[3])
  let steps = max(2, n.count > 4 ? Int(n[4]) : 12)
  post(.mouseMoved, a)
  usleep(20_000)
  post(.leftMouseDown, a)
  usleep(60_000)
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    post(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
    usleep(16_000)
  }
  usleep(40_000)
  post(.leftMouseUp, b)
case "scroll":
  guard n.count >= 4 else { usage() }
  let p = CGPoint(x: n[0], y: n[1])
  post(.mouseMoved, p)
  usleep(20_000)
  guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: Int32(n[3]), wheel2: Int32(n[2]), wheel3: 0) else { exit(1) }
  e.location = p
  e.postToPid(pid)
default:
  usage()
}
usleep(20_000)

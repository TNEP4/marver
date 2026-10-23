// Posts real key events to one process (spec 28 A2.14 #25): Playwright and sendInputEvent never reach AppKit's key
// equivalents, so "a key fires once" needs CGEvents. Posted to the app's pid alone (CGEventPostToPid), never to
// whatever app is in front.
//
//   keypost check                       prints "access: true|false" (CGPreflightPostEventAccess) and exits 0
//   keypost <pid> <keycode> [cmd,shift,alt,ctrl]   posts keyDown then keyUp with those modifiers
//
// The terminal running it needs Accessibility (System Settings > Privacy & Security); without it macOS drops the
// events silently, which is why every key case starts with its control case.
import ApplicationServices
import Foundation

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "check" {
  print("access: \(CGPreflightPostEventAccess())")
  exit(0)
}
guard args.count >= 3, let pid = pid_t(args[1]), let code = CGKeyCode(args[2]) else {
  FileHandle.standardError.write("usage: keypost <pid> <keycode> [cmd,shift,alt,ctrl] | keypost check\n".data(using: .utf8)!)
  exit(2)
}
var flags = CGEventFlags()
if args.count >= 4 {
  for m in args[3].split(separator: ",") {
    switch m {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: break
    }
  }
}
let src = CGEventSource(stateID: .hidSystemState)
for down in [true, false] {
  guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { exit(1) }
  e.flags = flags
  e.postToPid(pid)
  usleep(20_000)
}

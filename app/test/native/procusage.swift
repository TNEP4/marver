// A process's CPU, read from outside (spec 28 A3.8 #47, #49, r2 #1): proc_pid_rusage (RUSAGE_INFO_V4) gives each
// process's own user and system time and its reaped children's (ri_child_user_time, ri_child_system_time) - the
// kernel adds a reaped child's CPU, its own children's included, to its parent's, so a helper that lived wholly
// between two reads is still counted. The times are mach ticks, converted with mach_timebase_info. A process's start
// is proc_pidinfo's PROC_PIDTBSDINFO (epoch seconds and microseconds), to join a recorder line's `born` (within 1 s).
//
//   procusage check                   {"ok":true}: this process reads itself
//   procusage read <pid> [<pid>...]   one line a pid: {"pid","startedAt" (epoch ms),"ownS","childrenS","path"}, or
//                                     {"pid","missing":true}; exit 3 when any pid could not be read
//   procusage children <pid>          {"children":[...]}: the live children (proc_listchildpids)
//   procusage find <path-prefix>      {"pids":[...]}: every process whose executable is under that path (Crashpad's
//                                     handler, which launchd adopts, found inside the bundle)
//
// Reading another process of the same user needs no permission. Never root, never a signal.
import Darwin
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let UNREADABLE: Int32 = 3

var tb = mach_timebase_info_data_t()
mach_timebase_info(&tb)
func seconds(_ ticks: UInt64) -> Double { Double(ticks) * Double(tb.numer) / Double(tb.denom) / 1e9 }

func path(_ pid: Int32) -> String {
  var buf = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
  let n = proc_pidpath(pid, &buf, UInt32(buf.count))
  return n > 0 ? String(cString: buf) : ""
}

func esc(_ s: String) -> String {
  var o = ""
  for c in s.unicodeScalars {
    switch c {
    case "\"": o += "\\\""
    case "\\": o += "\\\\"
    default: o += c.value < 0x20 ? String(format: "\\u%04x", c.value) : String(c)
    }
  }
  return o
}

func read(_ pid: Int32) -> String? {
  var info = rusage_info_v4()
  let r = withUnsafeMutablePointer(to: &info) { p in
    p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  if r != 0 { return nil }
  var bsd = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  let got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, size)
  let startedAt = got == size ? Double(bsd.pbi_start_tvsec) * 1000 + Double(bsd.pbi_start_tvusec) / 1000 : -1
  let own = seconds(info.ri_user_time) + seconds(info.ri_system_time)
  let kids = seconds(info.ri_child_user_time) + seconds(info.ri_child_system_time)
  return String(format: "{\"pid\":%d,\"startedAt\":%.0f,\"ownS\":%.6f,\"childrenS\":%.6f,\"path\":\"%@\"}", pid, startedAt, own, kids, esc(path(pid)))
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else {
  FileHandle.standardError.write("usage: procusage check | read <pid>... | children <pid> | find <path-prefix>\n".data(using: .utf8)!)
  exit(2)
}
switch cmd {
case "check":
  print(read(getpid()) != nil ? "{\"ok\":true}" : "{\"ok\":false}")
case "read":
  var missing = false
  for a in args.dropFirst() {
    guard let pid = Int32(a) else { continue }
    if let l = read(pid) { print(l) } else { print("{\"pid\":\(pid),\"missing\":true}"); missing = true }
  }
  exit(missing ? UNREADABLE : 0)
case "children":
  guard args.count > 1, let pid = Int32(args[1]) else { exit(2) }
  var buf = [Int32](repeating: 0, count: 4096)
  let n = proc_listchildpids(pid, &buf, Int32(buf.count * MemoryLayout<Int32>.size))
  print("{\"children\":[\(n > 0 ? buf.prefix(Int(n)).map(String.init).joined(separator: ",") : "")]}")
case "find":
  guard args.count > 1 else { exit(2) }
  let prefix = args[1]
  var buf = [Int32](repeating: 0, count: 16384)
  let n = proc_listallpids(&buf, Int32(buf.count * MemoryLayout<Int32>.size))
  let pids = n > 0 ? buf.prefix(Int(n)).filter { $0 > 0 && path($0).hasPrefix(prefix) } : []
  print("{\"pids\":[\(pids.map(String.init).joined(separator: ","))]}")
default:
  exit(2)
}

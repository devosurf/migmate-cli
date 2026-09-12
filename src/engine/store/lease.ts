import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import net from "node:net";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { ok, refuse } from "../types.ts";
import type { JobState, Outcome, RecoveryReport, RefusalCode } from "../types.ts";
import { withSocketPath } from "../providers/socket-path.ts";

const HEARTBEAT_MS = 5_000;
const LEASE_EXPIRY_MS = 30_000;
const MIGMATE_VERSION = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version as string;

export interface LeaseIdentity {
  hostId: string;
  pid: number;
  processStartTime: number;
}

export interface LeaseRow extends LeaseIdentity {
  ownerUuid: string;
  heartbeatAt: string;
  kind: "cli" | "web";
  socketPath: string | null;
  workerGroup: string | null;
  workerPid: number | null;
  workerProcessStartTime: number | null;
  workerExecutable: string | null;
  lastCheckpoint: string | null;
  migmateVersion: string;
}

export interface LeaseHandle {
  row: LeaseRow;
  timer: NodeJS.Timeout | null;
}

export interface ReclaimInputs {
  heartbeatExpired: boolean;
  hostMatches: boolean;
  ownerProcessGone: boolean;
  workerSocketSilent: boolean;
}

export interface ReclaimDecision {
  reclaimable: boolean;
  code: RefusalCode | null;
}

type Presence = "alive" | "absent" | "unknown";
type ProcessStatus = Presence | "mismatched";

export interface LeaseInspectionOptions {
  now?: () => Date;
  expiryMs?: number;
  probeWorker?: (socketPath: string) => Promise<boolean | null>;
  processAlive?: (pid: number, startTime: number) => boolean | null;
}

export interface LeaseAcquireOptions extends LeaseInspectionOptions {
  kind: "cli" | "web";
  socketPath?: string | null;
  workerGroup?: string | null;
  workerPid?: number | null;
  workerProcessStartTime?: number | null;
  workerExecutable?: string | null;
  lastCheckpoint?: string | null;
  migmateVersion?: string;
  heartbeatMs?: number;
}

export interface LeaseInspection {
  report: RecoveryReport;
  decision: ReclaimDecision;
  stopEligible: boolean;
  ownerStatus: ProcessStatus;
  workerStatus: Presence;
  socketStatus: Presence;
}

export interface LeaseReconciliationResult {
  changed: boolean;
  state: JobState;
  recovery: RecoveryReport | null;
}

interface JobRow {
  id: string;
  state: JobState;
  hostId: string | null;
  lastCheckpoint: string | null;
}

interface ProcessIdentity {
  startTime: number;
  uid: string | null;
  executable: string | null;
  // Linux and Windows expose argv boundaries. macOS ps exposes a flat command;
  // its exact rcd prefix is checked separately, never shell-tokenized.
  argv: string[] | null;
  command: string | null;
}

type ProcessObservation =
  { status: "alive"; identity: ProcessIdentity } | { status: "absent" | "unknown" };

const SELECT_LEASE_SQL = `SELECT owner_uuid AS ownerUuid, host_id AS hostId, pid,
  process_start_time AS processStartTime, heartbeat_at AS heartbeatAt, kind,
  socket_path AS socketPath, worker_group AS workerGroup, worker_pid AS workerPid,
  worker_process_start_time AS workerProcessStartTime, worker_executable AS workerExecutable,
  last_checkpoint AS lastCheckpoint, migmate_version AS migmateVersion FROM lease WHERE id = 1`;

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function windowsCommand(
  script: string,
  extra: NodeJS.ProcessEnv = {},
  cwd?: string,
): string | null {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !isAbsolute(root)) return null;
  const result = spawnSync(
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); ${script}`,
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      cwd,
      env: {
        SystemRoot: root,
        SYSTEMROOT: root,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        ...extra,
      },
    },
  );
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

// GetOwnerSid and CreationDate come from the actual process, not an estimate of
// this coordinator's uptime. CommandLineToArgvW preserves quoted path boundaries.
const WINDOWS_PROCESS_SCRIPT = `
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:MIGMATE_INSPECT_PID);
if($null -eq $p){Write-Output 'absent';exit 0};
$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;
if($owner.ReturnValue -ne 0){throw 'owner unavailable'};
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class MigmateArgv {
 [DllImport("shell32.dll",SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s,out int n);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static string[] Parse(string s) { int n; IntPtr p=CommandLineToArgvW(s,out n); if(p==IntPtr.Zero)throw new Exception();
 try { string[] a=new string[n]; for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return a; } finally {LocalFree(p);} }
}';
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
@{ startTime=([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();
 uid=($(if($owner.Sid -eq $current){'self'}else{$owner.Sid}));
 executable=$p.ExecutablePath; argv=@([MigmateArgv]::Parse($p.CommandLine)); command=$null } | ConvertTo-Json -Compress
`;

function readProcess(pid: number): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unknown" };
  try {
    if (process.platform === "linux") {
      // Field 22 is the kernel start tick, not a wall-clock approximation. It is
      // compared as an opaque identity and cannot change when the clock changes.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(") ");
      if (end < 0) return { status: "unknown" };
      const fields = stat
        .slice(end + 2)
        .trim()
        .split(/\s+/u);
      const startTime = Number(fields[19]);
      if (!Number.isSafeInteger(startTime) || startTime <= 0) return { status: "unknown" };
      if (fields[0] === "Z" || fields[0] === "X") return { status: "absent" };
      const uid = /^Uid:\s+(\d+)\s+(\d+)/mu.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      let executable: string | null = null;
      let argv: string[] | null = null;
      try {
        executable = readlinkSync(`/proc/${pid}/exe`);
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (argv.at(-1) === "") argv.pop();
      } catch {
        /* Inaccessible process details never authorize termination. */
      }
      return {
        status: "alive",
        identity: { startTime, uid: uid?.[2] ?? null, executable, argv, command: null },
      };
    }
    if (process.platform === "darwin") {
      const result = spawnSync(
        "/bin/ps",
        ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "stat=", "-o", "comm="],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 1024 * 1024,
          env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
        },
      );
      if (result.error || result.status !== 0 || !result.stdout.trim()) {
        return processExistence(pid);
      }
      const match =
        /^\s*(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(
          result.stdout.trim(),
        );
      if (!match) return { status: "unknown" };
      const startTime = Date.parse(`${match[1]!} UTC`);
      if (!Number.isFinite(startTime)) return { status: "unknown" };
      if (match[3]!.startsWith("Z")) return { status: "absent" };
      const args = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
      return {
        status: "alive",
        identity: {
          startTime,
          uid: match[2]!,
          executable: match[4]!,
          argv: null,
          command: args.error || args.status !== 0 ? null : args.stdout.trim(),
        },
      };
    }
    if (process.platform === "win32") {
      const text = windowsCommand(WINDOWS_PROCESS_SCRIPT, { MIGMATE_INSPECT_PID: String(pid) });
      if (text === "absent") return { status: "absent" };
      if (text === null) return { status: "unknown" };
      const data: unknown = JSON.parse(text);
      if (
        !data ||
        typeof data !== "object" ||
        !("startTime" in data) ||
        typeof data.startTime !== "number" ||
        !Number.isSafeInteger(data.startTime) ||
        data.startTime <= 0 ||
        !("uid" in data) ||
        typeof data.uid !== "string" ||
        !("executable" in data) ||
        typeof data.executable !== "string" ||
        !("argv" in data) ||
        !Array.isArray(data.argv) ||
        !data.argv.every((arg) => typeof arg === "string")
      )
        return { status: "unknown" };
      return {
        status: "alive",
        identity: {
          startTime: data.startTime,
          uid: data.uid,
          executable: data.executable,
          argv: data.argv,
          command: null,
        },
      };
    }
  } catch (error) {
    // Only an absent process directory / ESRCH proves loss; EPERM, malformed
    // output, missing tools, timeouts and unsupported platforms remain unknown.
    if (process.platform === "linux" && isErrnoCode(error, "ENOENT")) return processExistence(pid);
  }
  return { status: "unknown" };
}

function processExistence(pid: number): ProcessObservation {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return { status: "absent" };
  }
  return { status: "unknown" };
}

function statusOf(observation: ProcessObservation, startTime: number): ProcessStatus {
  if (!Number.isSafeInteger(startTime) || startTime <= 0) return "unknown";
  if (observation.status !== "alive") return observation.status;
  return observation.identity.startTime === startTime ? "alive" : "mismatched";
}

export function getProcessStartTime(pid = process.pid): number {
  const observed = readProcess(pid);
  if (observed.status !== "alive")
    throw new Error("Process start identity could not be established");
  return observed.identity.startTime;
}

/** Unknown is deliberately distinct from false: callers must never negate it. */
export function processAlive(pid: number, startTime: number): boolean | null {
  const status = statusOf(readProcess(pid), startTime);
  return status === "unknown" ? null : status === "alive";
}

function windowsPrivate(path: string, create = false): boolean {
  const setup = create
    ? `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.FileSecurity;
if(Test-Path -LiteralPath $env:MIGMATE_PRIVATE_PATH -PathType Container){$acl=New-Object System.Security.AccessControl.DirectorySecurity};
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));
Set-Acl -LiteralPath $env:MIGMATE_PRIVATE_PATH -AclObject $acl;`
    : "";
  return (
    windowsCommand(
      `${setup}
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$item=Get-Item -LiteralPath $env:MIGMATE_PRIVATE_PATH -Force;
if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){exit 1};
$acl=Get-Acl -LiteralPath $env:MIGMATE_PRIVATE_PATH;
if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid){exit 1};
$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);
if($rules.Count -eq 0){exit 1};
foreach($rule in $rules){if($rule.IdentityReference -ne $sid -or $rule.AccessControlType -ne 'Allow'){exit 1}};
Write-Output 'private'`,
      { MIGMATE_PRIVATE_PATH: path },
    ) === "private"
  );
}

function privatePath(path: string, directory: boolean): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) return false;
    if (process.platform === "win32") return windowsPrivate(path);
    return (
      process.getuid !== undefined && info.uid === process.getuid() && (info.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

/** A reader must not create a home, repair permissions, or replace identity. */
export function readHostId(home: string): string | null {
  const file = join(home, "hostId");
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const before = lstatSync(file),
      opened = fstatSync(fd);
    if (
      !privatePath(home, true) ||
      !privatePath(file, false) ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      !opened.isFile()
    )
      throw new Error("Unsafe host identity file");
    const hostId = readFileSync(fd, "utf8").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(hostId))
      throw new Error("Invalid host identity file");
    return hostId;
  } finally {
    closeSync(fd);
  }
}

export function getHostId(home: string): string {
  const existing = readHostId(home);
  if (existing !== null) return existing;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(home).isSymbolicLink()) throw new Error("Unsafe engine home");
  if (process.platform === "win32" && !windowsPrivate(home, true))
    throw new Error("Unsafe engine home");
  if (!privatePath(home, true)) throw new Error("Unsafe engine home");
  const file = join(home, "hostId"),
    temp = join(home, `.hostId.${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      if (process.platform === "win32" && !windowsPrivate(temp, true))
        throw new Error("Unsafe host identity file");
      writeFileSync(fd, `${randomUUID()}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, file);
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
    }
  } finally {
    unlinkSync(temp);
    // Windows does not expose directory fsync through Node; the fully flushed
    // file is installed with a non-replacing hard link on its local volume.
    if (process.platform !== "win32") {
      const directory = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }
  const installed = readHostId(home);
  if (installed === null) throw new Error("Host identity installation failed");
  return installed;
}

// Node's Windows path sockets are named pipes, not AF_UNIX. Use native Winsock
// to check the recorded rclone AF_UNIX endpoint, without executing a worker or
// attempting authenticated RC (its credentials died with the original owner).
const WINDOWS_SOCKET_SCRIPT = `
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; using System.Threading.Tasks;
public static class MigmateSocket {
 [DllImport("ws2_32.dll")] static extern int WSAStartup(ushort v,byte[] d);
 [DllImport("ws2_32.dll")] static extern int WSACleanup();
 [DllImport("ws2_32.dll")] static extern UIntPtr socket(int a,int t,int p);
 [DllImport("ws2_32.dll")] static extern int connect(UIntPtr s,byte[] a,int n);
 [DllImport("ws2_32.dll")] static extern int closesocket(UIntPtr s);
 [DllImport("ws2_32.dll")] static extern int WSAGetLastError();
 public static string Probe(string path) {
  byte[] name=Encoding.UTF8.GetBytes(path); if(name.Length>=108)return "unknown";
  if(WSAStartup(0x202,new byte[512])!=0)return "unknown";
  UIntPtr s=socket(1,1,0);
  if(s==new UIntPtr(UInt64.MaxValue)){WSACleanup();return "unknown";}
  try { byte[] a=new byte[110];a[0]=1;Array.Copy(name,0,a,2,name.Length);
   Task<int> task=Task.Run(()=>{int r=connect(s,a,a.Length);return r==0?0:WSAGetLastError();});
   if(!task.Wait(1000))return "unknown"; int e=task.Result;
   return e==0?"alive":e==10061?"absent":"unknown";
  } finally {closesocket(s);WSACleanup();}
 }
}';
[MigmateSocket]::Probe($env:MIGMATE_INSPECT_SOCKET)
`;

/** Any answer proves liveness; only definitive refusal/absence proves silence. */
export async function probeWorker(socketPath: string): Promise<boolean | null> {
  if (!socketPath || !isAbsolute(socketPath)) return null;
  if (process.platform === "win32") {
    try {
      lstatSync(socketPath);
    } catch (error) {
      return isErrnoCode(error, "ENOENT") ? false : null;
    }
    const state = windowsCommand(
      WINDOWS_SOCKET_SCRIPT,
      { MIGMATE_INSPECT_SOCKET: basename(socketPath) },
      dirname(socketPath),
    );
    return state === "alive" ? true : state === "absent" ? false : null;
  }
  try {
    return await withSocketPath(
      socketPath,
      async (path) =>
        await new Promise<boolean | null>((resolveProbe) => {
          const socket = net.createConnection({ path });
          const finish = (value: boolean | null): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolveProbe(value);
          };
          socket.once("connect", () => finish(true));
          socket.once("error", (error) =>
            finish(
              isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ECONNREFUSED") ? false : null,
            ),
          );
          socket.setTimeout(1_000, () => finish(null));
        }),
    );
  } catch (error) {
    return isErrnoCode(error, "ENOENT") ? false : null;
  }
}

function heartbeatAgeMs(heartbeatAt: string, now: () => Date): number {
  const elapsed = now().getTime() - Date.parse(heartbeatAt);
  // Malformed clocks must not manufacture an expired heartbeat.
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

export function evaluateReclaim(i: ReclaimInputs): ReclaimDecision {
  if (!i.hostMatches) return { reclaimable: false, code: "foreign_host" };
  if (!i.heartbeatExpired || !i.ownerProcessGone) return { reclaimable: false, code: "lease_held" };
  if (!i.workerSocketSilent) return { reclaimable: false, code: "lease_stale_worker_alive" };
  return { reclaimable: true, code: null };
}

// CWD is an OS fact, not inferred from the worker's --cache-dir argument.
// On native 64-bit Windows, read the process parameters through a query/read
// handle. WOW64/denied handles are unknown; no address or path is guessed.
const WINDOWS_CWD_SCRIPT = `
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices;
public static class MigmateCwd {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr Reserved, Peb, R1, R2, Pid, R3; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr p,IntPtr a,byte[] b,IntPtr n,out IntPtr read);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process(IntPtr p,out bool wow);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p,int c,out Basic b,int n,out int read);
 static byte[] Read(IntPtr h,IntPtr p,int n) { byte[] b=new byte[n];IntPtr count;
  if(!ReadProcessMemory(h,p,b,new IntPtr(n),out count)||count.ToInt64()!=n)throw new Exception();return b; }
 public static string Read(int pid) {
  if(IntPtr.Size!=8)return null; IntPtr h=OpenProcess(0x410,false,pid);if(h==IntPtr.Zero)return null;
  try { bool wow; if(!IsWow64Process(h,out wow)||wow)return null;
   Basic b;int count;if(NtQueryInformationProcess(h,0,out b,Marshal.SizeOf(typeof(Basic)),out count)!=0)return null;
   IntPtr parameters=new IntPtr(BitConverter.ToInt64(Read(h,IntPtr.Add(b.Peb,0x20),8),0));
   byte[] path=Read(h,IntPtr.Add(parameters,0x38),16);int length=BitConverter.ToUInt16(path,0);
   if(length<=0||length>32766||(length%2)!=0)return null;
   IntPtr buffer=new IntPtr(BitConverter.ToInt64(path,8));
   return Encoding.Unicode.GetString(Read(h,buffer,length));
  } catch { return null; } finally {CloseHandle(h);}
 }
}';
$cwd=[MigmateCwd]::Read([int]$env:MIGMATE_INSPECT_PID); if($null -eq $cwd){exit 1}; ConvertTo-Json -Compress -InputObject $cwd
`;

function readProcessCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F0n"], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 65536,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin" },
      });
      if (result.error || result.status !== 0) return null;
      const names = result.stdout.split("\0").filter((field) => field.startsWith("n"));
      return names.length === 1 ? names[0]!.slice(1) : null;
    }
    if (process.platform === "win32") {
      const text = windowsCommand(WINDOWS_CWD_SCRIPT, { MIGMATE_INSPECT_PID: String(pid) });
      if (text === null) return null;
      const cwd: unknown = JSON.parse(text);
      return typeof cwd === "string" ? cwd : null;
    }
  } catch {
    /* Unknown cwd cannot prove relative socket ownership. */
  }
  return null;
}

function workerOwned(row: LeaseRow, observed: ProcessObservation): boolean {
  if (
    observed.status !== "alive" ||
    !row.workerPid ||
    !row.workerProcessStartTime ||
    !row.workerExecutable ||
    !row.socketPath ||
    !row.workerGroup?.trim() ||
    !isAbsolute(row.workerExecutable) ||
    !isAbsolute(row.socketPath) ||
    statusOf(observed, row.workerProcessStartTime) !== "alive"
  )
    return false;
  const identity = observed.identity,
    directory = dirname(row.socketPath),
    cwd = readProcessCwd(row.workerPid);
  if (
    identity.uid !== (process.platform === "win32" ? "self" : String(process.getuid?.())) ||
    !identity.executable ||
    !isAbsolute(identity.executable) ||
    !cwd ||
    !isAbsolute(cwd) ||
    !privatePath(directory, true)
  )
    return false;
  try {
    if (
      realpathSync(identity.executable) !== realpathSync(row.workerExecutable) ||
      realpathSync(directory) !== resolve(directory) ||
      realpathSync(cwd) !== realpathSync(directory)
    )
      return false;
  } catch {
    return false;
  }
  if (basename(row.socketPath) !== "s" || !basename(directory).startsWith("rc-")) return false;
  const expected = "unix://s";
  if (identity.argv !== null) {
    const argv = identity.argv;
    if (
      argv[1] !== "rcd" ||
      argv[2] !== "--rc-addr" ||
      argv[3] !== expected ||
      argv[4] !== "--rc-serve"
    )
      return false;
    for (const flag of ["--cache-dir", "--temp-dir"]) {
      const index = argv.indexOf(flag);
      if (index < 0 || argv[index + 1] !== directory || argv.lastIndexOf(flag) !== index)
        return false;
    }
    return argv.lastIndexOf("--rc-addr") === 2;
  }
  // macOS ps returns the actual kernel executable separately. Its argv display
  // is not shell syntax: compare the complete fixed leading arguments including
  // the trailing flag, so a socket substring or quoted lookalike cannot match.
  const directories = ` --cache-dir ${directory} --temp-dir ${directory}`;
  return (
    identity.command !== null &&
    identity.command.startsWith(
      `${row.workerExecutable} rcd --rc-addr ${expected} --rc-serve --config `,
    ) &&
    (identity.command.includes(`${directories} `) || identity.command.endsWith(directories)) &&
    identity.command.indexOf(" --rc-addr ", identity.command.indexOf(" --rc-addr ") + 1) === -1
  );
}

export async function inspectLease(
  row: LeaseRow,
  thisHostId: string,
  opts: LeaseInspectionOptions = {},
): Promise<LeaseInspection> {
  const now = opts.now ?? (() => new Date());
  const age = heartbeatAgeMs(row.heartbeatAt, now);
  const hostMatches = row.hostId === thisHostId;
  let ownerStatus: ProcessStatus = "unknown",
    socketStatus: Presence = "unknown",
    workerStatus: Presence = "unknown";
  let worker: ProcessObservation = { status: "unknown" };
  if (hostMatches) {
    try {
      if (opts.processAlive) {
        const alive = opts.processAlive(row.pid, row.processStartTime);
        ownerStatus = alive === true ? "alive" : alive === false ? "absent" : "unknown";
      } else ownerStatus = statusOf(readProcess(row.pid), row.processStartTime);
    } catch {
      ownerStatus = "unknown";
    }
    if (row.socketPath === null) socketStatus = "absent";
    else {
      try {
        const alive = await (opts.probeWorker ?? probeWorker)(row.socketPath);
        socketStatus = alive === true ? "alive" : alive === false ? "absent" : "unknown";
      } catch {
        socketStatus = "unknown";
      }
    }
    worker = row.workerPid === null ? { status: "absent" } : readProcess(row.workerPid);
    if (socketStatus === "alive") workerStatus = "alive";
    else if (worker.status === "alive") {
      workerStatus =
        row.workerProcessStartTime !== null &&
        statusOf(worker, row.workerProcessStartTime) === "alive"
          ? "alive"
          : "unknown";
    } else if (socketStatus === "absent" && worker.status === "absent") {
      // A socket/group claim without its PID is incomplete, not proof of loss.
      workerStatus =
        row.workerPid !== null ||
        (row.socketPath === null &&
          row.workerGroup === null &&
          row.workerProcessStartTime === null &&
          row.workerExecutable === null)
          ? "absent"
          : "unknown";
    }
  }
  const ownerGone = ownerStatus === "absent" || ownerStatus === "mismatched";
  const expired = age >= (opts.expiryMs ?? LEASE_EXPIRY_MS);
  const decision = evaluateReclaim({
    heartbeatExpired: expired,
    hostMatches,
    ownerProcessGone: ownerGone,
    workerSocketSilent: socketStatus === "absent" && workerStatus === "absent",
  });
  return {
    decision,
    ownerStatus,
    workerStatus,
    socketStatus,
    stopEligible:
      hostMatches &&
      expired &&
      ownerGone &&
      workerStatus === "alive" &&
      socketStatus !== "unknown" &&
      workerOwned(row, worker),
    report: {
      workerAlive: workerStatus === "alive",
      workerStatus,
      recordedHostId: row.hostId,
      thisHostId,
      holder: {
        ownerUuid: row.ownerUuid,
        pid: row.pid,
        processStartTime: row.processStartTime,
        heartbeatAt: row.heartbeatAt,
        heartbeatAgeMs: age,
        kind: row.kind,
      },
      workerGroup: row.workerGroup,
      lastCheckpoint: row.lastCheckpoint,
      reclaimable: decision.reclaimable,
    },
  };
}

export async function buildRecoveryReport(
  row: LeaseRow,
  thisHostId: string,
  opts: LeaseInspectionOptions = {},
): Promise<RecoveryReport> {
  return (await inspectLease(row, thisHostId, opts)).report;
}

/** Only called after inspectLease authorizes deliberate recovery on this host.
 * The durable group is a run association, not an OS group or usable RC job id.
 * Lost memory-only RC credentials preclude cooperative RC shutdown. */
export async function stopOrphanWorker(row: LeaseRow): Promise<boolean> {
  if (row.workerPid === null || row.workerPid === process.pid) return false;
  const maySignal = async (): Promise<boolean> => {
    const owner = statusOf(readProcess(row.pid), row.processStartTime);
    if (owner !== "absent" && owner !== "mismatched") return false;
    if (
      heartbeatAgeMs(row.heartbeatAt, () => new Date()) < LEASE_EXPIRY_MS ||
      row.socketPath === null ||
      (await probeWorker(row.socketPath)) === null
    )
      return false;
    return (
      workerOwned(row, readProcess(row.workerPid!)) &&
      statusOf(readProcess(row.workerPid!), row.workerProcessStartTime ?? Number.NaN) === "alive"
    );
  };
  // Each signal is authorized by maySignal's full ownership proof. Waiting for
  // the exit cannot repeat it: a dying process loses its executable, argv and
  // cwd links before it is reaped, so an unreadable identity would read as
  // "not ours" and abandon a worker this host has already terminated. The
  // recorded start time still identifies the pid, so only proven reuse stops
  // the bounded wait.
  const awaitAbsent = async (timeout: number): Promise<boolean> => {
    const deadline = performance.now() + timeout;
    do {
      const observed = readProcess(row.workerPid!);
      if (observed.status === "absent") return true;
      if (statusOf(observed, row.workerProcessStartTime ?? Number.NaN) === "mismatched")
        return false;
      await delay(50);
    } while (performance.now() < deadline);
    return false;
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await maySignal())) return false;
    try {
      process.kill(row.workerPid, signal);
    } catch (error) {
      return isErrnoCode(error, "ESRCH");
    }
    if (await awaitAbsent(signal === "SIGTERM" ? 3_000 : 1_000)) return true;
  }
  return false;
}

function readLeaseRow(db: DatabaseSync): LeaseRow | null {
  return (db.prepare(SELECT_LEASE_SQL).get() as LeaseRow | undefined) ?? null;
}

function readJobRow(db: DatabaseSync): JobRow {
  const row = db
    .prepare(
      "SELECT id, state, host_id AS hostId, last_checkpoint AS lastCheckpoint FROM job LIMIT 1",
    )
    .get() as JobRow | undefined;
  if (!row) throw new Error("Job row missing");
  return row;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* The failed transaction is already unwound. */
  }
}

export async function acquire(
  db: DatabaseSync,
  identity: LeaseIdentity,
  opts: LeaseAcquireOptions,
): Promise<Outcome<LeaseHandle>> {
  const now = opts.now ?? (() => new Date());
  if (
    !identity.hostId ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isSafeInteger(identity.processStartTime) ||
    identity.processStartTime <= 0
  )
    throw new Error("Invalid lease identity");
  const ownerUuid = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  let row: LeaseRow;
  try {
    const job = readJobRow(db),
      existing = readLeaseRow(db);
    if (job.hostId !== null && job.hostId !== identity.hostId) {
      db.exec("ROLLBACK");
      return refuse("foreign_host", "Live job state belongs to another host", {
        recovery: {
          recordedHostId: job.hostId,
          thisHostId: identity.hostId,
          holder: null,
          workerAlive: false,
          workerStatus: "unknown",
          workerGroup: existing?.workerGroup ?? null,
          lastCheckpoint: job.lastCheckpoint,
          reclaimable: false,
        },
      });
    }
    if (existing !== null) {
      db.exec("ROLLBACK");
      const inspection = await inspectLease(existing, identity.hostId, opts);
      return refuse(
        inspection.decision.code ?? "lease_held",
        "The existing lease requires explicit recovery",
        { recovery: inspection.report },
      );
    }
    row = {
      ...identity,
      ownerUuid,
      heartbeatAt: now().toISOString(),
      kind: opts.kind,
      socketPath: opts.socketPath ?? null,
      workerGroup: opts.workerGroup ?? null,
      workerPid: opts.workerPid ?? null,
      workerProcessStartTime: opts.workerProcessStartTime ?? null,
      workerExecutable: opts.workerExecutable ?? null,
      lastCheckpoint: opts.lastCheckpoint ?? job.lastCheckpoint,
      migmateVersion: opts.migmateVersion ?? MIGMATE_VERSION,
    };
    db.prepare(
      `INSERT INTO lease (id, owner_uuid, host_id, pid, process_start_time, heartbeat_at, kind,
      socket_path, worker_group, worker_pid, worker_process_start_time, worker_executable, last_checkpoint, migmate_version)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ownerUuid,
      row.hostId,
      row.pid,
      row.processStartTime,
      row.heartbeatAt,
      row.kind,
      row.socketPath,
      row.workerGroup,
      row.workerPid,
      row.workerProcessStartTime,
      row.workerExecutable,
      row.lastCheckpoint,
      row.migmateVersion,
    );
    db.prepare("UPDATE job SET host_id = ? WHERE id = ? AND host_id IS NULL").run(
      identity.hostId,
      job.id,
    );
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
  const handle: LeaseHandle = { row, timer: null };
  handle.timer = setInterval(() => {
    try {
      heartbeat(db, handle, now);
    } catch {
      clearInterval(handle.timer ?? undefined);
      handle.timer = null;
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  handle.timer.unref();
  return ok(handle);
}

export function heartbeat(
  db: DatabaseSync,
  handle: LeaseHandle,
  now: () => Date = () => new Date(),
): boolean {
  const row = handle.row;
  const updated =
    db
      .prepare(
        `UPDATE lease SET heartbeat_at = ? WHERE id = 1 AND owner_uuid = ?
    AND host_id = ? AND pid = ? AND process_start_time = ?`,
      )
      .run(now().toISOString(), row.ownerUuid, row.hostId, row.pid, row.processStartTime)
      .changes === 1;
  if (!updated && handle.timer !== null) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  return updated;
}

export function release(db: DatabaseSync, handle: LeaseHandle): boolean {
  if (handle.timer !== null) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  const row = handle.row;
  // A surviving worker claim must be recovered explicitly, never discarded by
  // a finally block. The controlled supervisor clears the claim after exit.
  return (
    db
      .prepare(
        `DELETE FROM lease WHERE id = 1 AND owner_uuid = ? AND host_id = ?
    AND pid = ? AND process_start_time = ? AND socket_path IS NULL AND worker_pid IS NULL
    AND worker_group IS NULL AND worker_process_start_time IS NULL AND worker_executable IS NULL`,
      )
      .run(row.ownerUuid, row.hostId, row.pid, row.processStartTime).changes === 1
  );
}

export async function withLease<T>(
  db: DatabaseSync,
  identity: LeaseIdentity,
  opts: LeaseAcquireOptions,
  fn: (lease: LeaseHandle) => Promise<T>,
): Promise<Outcome<T>> {
  const acquired = await acquire(db, identity, opts);
  if (!acquired.ok) return acquired;
  try {
    return ok(await fn(acquired.value));
  } finally {
    release(db, acquired.value);
  }
}

/** Writer-open reconciliation is not reclaim. Only the freshly acquired owner
 * may rewrite executing, under the same write lock that rechecks ownership. */
export async function reconcileWriterOpen(
  db: DatabaseSync,
  reconcile: (state: JobState) => JobState,
  opts: LeaseInspectionOptions & { hostId?: string; ownerUuid?: string } = {},
): Promise<LeaseReconciliationResult> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = readJobRow(db),
      lease = readLeaseRow(db);
    const owned =
      lease !== null &&
      opts.ownerUuid !== undefined &&
      lease.ownerUuid === opts.ownerUuid &&
      opts.hostId === lease.hostId &&
      job.hostId === opts.hostId &&
      lease.pid === process.pid &&
      statusOf(readProcess(lease.pid), lease.processStartTime) === "alive";
    if (!owned || job.state !== "executing") {
      db.exec("ROLLBACK");
      const recovery =
        lease === null ? null : (await inspectLease(lease, opts.hostId ?? "", opts)).report;
      return { changed: false, state: job.state, recovery };
    }
    const next = reconcile(job.state);
    db.prepare("UPDATE job SET state = ? WHERE id = ?").run(next, job.id);
    db.exec("COMMIT");
    return { changed: next !== job.state, state: next, recovery: null };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

// Launcher for the Microsoft Power BI Modeling MCP server, adapted to run inside
// Claude Desktop on Windows. Spawns the underlying powerbi-modeling-mcp.exe and
// bridges stdio between Claude (parent) and the .exe (child).
//
// Why this launcher exists rather than using @microsoft/powerbi-modeling-mcp
// directly via npx:
//   1. Microsoft's outer Node wrapper writes diagnostic text to stdout, which
//      corrupts MCP's JSON-RPC channel. (issue microsoft/powerbi-modeling-mcp#87)
//   2. Microsoft's platform wrapper swallows signal kills as exit code 0,
//      hiding failures. (issue #87)
//   3. Electron's run-as-node mode (which Claude Desktop uses to host MCP
//      servers) fragments large process.stdout writes when the parent reads
//      via Electron's IPC pipe. Microsoft's tools/list response (~75 KB)
//      arrives at Claude split at the 64 KB Windows pipe-buffer boundary, and
//      Claude treats each fragment as a separate (invalid) JSON-RPC message.
//      fs.writeSync to fd 1 doesn't help — that descriptor is not connected
//      to Claude in run-as-node mode.
//
// This launcher fixes all three by:
//   - Skipping Microsoft's Node wrappers and spawning the .exe directly.
//   - Line-buffering the .exe's stdout so each complete MCP frame is delivered
//     to Claude in a single process.stdout.write call.
//
// Set POWERBI_MCP_DEBUG=1 in the environment to write byte-level diagnostics
// (stdin/stdout chunk sizes and content prefixes) to launcher.log next to this
// file. By default only structural events (startup, child spawn, exit) are logged.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEBUG = process.env.POWERBI_MCP_DEBUG === "1";
const logPath = path.join(__dirname, "launcher.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logPath, line); } catch {}
  try { process.stderr.write(line); } catch {}
}

function dlog(msg) {
  if (!DEBUG) return;
  try { fs.appendFileSync(logPath, msg.endsWith("\n") ? msg : msg + "\n"); } catch {}
}

try {
  const platPkgJsonPath = require.resolve("@microsoft/powerbi-modeling-mcp-win32-x64/package.json");
  const platPkg = require("@microsoft/powerbi-modeling-mcp-win32-x64/package.json");
  const platDir = path.dirname(platPkgJsonPath);
  const execName = Object.values(platPkg.bin)[0];
  const execPath = path.join(platDir, execName);
  log("launcher start | execPath=" + execPath + (DEBUG ? " | DEBUG=on" : ""));

  const child = spawn(execPath, ["--start"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: platDir,
    windowsHide: true,
  });
  log("child spawned, pid=" + child.pid);

  // Forward Claude → child stdin
  process.stdin.on("data", (chunk) => {
    if (DEBUG) dlog(`[stdin-recv ${chunk.length}b] ${chunk.toString("utf8").substring(0, 200).replace(/\n/g, "\\n")}`);
    try { child.stdin.write(chunk); } catch (e) { log("child.stdin.write err: " + e.message); }
  });
  process.stdin.on("end", () => {
    log("parent stdin ended");
    try { child.stdin.end(); } catch {}
  });

  // Forward child → Claude stdout via process.stdout.write (which IS connected
  // to Claude in Electron run-as-node — fd 1 is not). Line-buffer so each
  // complete MCP frame is written in one process.stdout.write call, preserving
  // message atomicity even when the .exe writes the response in multiple pipe
  // chunks (which it does for large tools/list responses).
  let outBuf = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    if (DEBUG) dlog(`[stdout-recv ${chunk.length}b] prefix=${chunk.toString("utf8").substring(0, 100).replace(/\n/g, "\\n")}`);
    outBuf = Buffer.concat([outBuf, chunk]);
    let nl;
    while ((nl = outBuf.indexOf(0x0A)) !== -1) {
      const line = outBuf.slice(0, nl + 1);
      outBuf = outBuf.slice(nl + 1);
      const ok = process.stdout.write(line);
      if (DEBUG) dlog(`[stdout-write ${line.length}b ok=${ok}]`);
    }
  });

  // .NET ILogger output (tool registration, etc.) goes to stderr — pass it
  // through to the parent so it appears in Claude's developer log, and tee
  // to launcher.log for offline inspection.
  child.stderr.on("data", (chunk) => {
    try { fs.appendFileSync(logPath, chunk); } catch {}
    try { process.stderr.write(chunk); } catch {}
  });

  child.on("error", (err) => {
    log("spawn error: " + (err.stack || err.message));
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    log("child exit code=" + code + " signal=" + signal);
    process.exit(code ?? (signal ? 1 : 0));
  });
} catch (e) {
  log("launcher threw: " + (e.stack || e.message));
  process.exit(1);
}

# Power BI Modeling MCP for Claude Desktop

A working [MCPB bundle](https://github.com/modelcontextprotocol/mcpb) that wraps Microsoft's official [`@microsoft/powerbi-modeling-mcp`](https://github.com/microsoft/powerbi-modeling-mcp) so it actually runs inside **Claude Desktop on Windows**.

Microsoft's npm package is built primarily around VS Code + GitHub Copilot. Plugging it into Claude Desktop straight from `npx` does not work — the connection drops on every tool call. This bundle ships a small Node launcher that works around three real bugs (two upstream in Microsoft's wrappers, one in Electron's `run-as-node` mode) so you get the full Power BI modeling toolset — schemas, DAX, measures, tables, relationships — inside Claude Desktop.

## What you get

Once installed, Claude Desktop exposes the full Power BI Modeling MCP tool catalog (21 tools at the time of writing):

`database_operations`, `table_operations`, `column_operations`, `measure_operations`, `relationship_operations`, `dax_query_operations`, `model_operations`, `partition_operations`, `calculation_group_operations`, `calendar_operations`, `query_group_operations`, `function_operations`, `named_expression_operations`, `object_translation_operations`, `perspective_operations`, `security_role_operations`, `culture_operations`, `user_hierarchy_operations`, `connection_operations`, `transaction_operations`, `trace_operations`.

Plus six declared prompts: `ConnectToPowerBIDesktop`, `ConnectToFabric`, `ConnectToPBIP`, `CreateDAXQuery`, `RunDAXQueryWithMetrics`, `AnalyzeDAXQuery`.

## Why this bundle exists — the bugs being worked around

Three independent issues stack on top of each other when Claude Desktop spawns the unmodified `@microsoft/powerbi-modeling-mcp@latest`:

1. **Microsoft outer wrapper writes to stdout** ([microsoft/powerbi-modeling-mcp issue #87](https://github.com/microsoft/powerbi-modeling-mcp/issues/87) — Bug 3). `console.log("Detected platform: …")` and `console.log("Using @microsoft/…-win32-x64 …")` corrupt the JSON-RPC channel before the .NET binary ever sends a frame. Any MCP client rejects the bytes as invalid JSON-RPC.
2. **Microsoft platform wrapper swallows signal kills** ([issue #87](https://github.com/microsoft/powerbi-modeling-mcp/issues/87) — Bug 2). `resolve(code || 0)` in the platform wrapper turns a `SIGKILL`/`null` exit code into a clean `0`, hiding failures.
3. **Electron run-as-node `process.stdout` fragments large writes** when the parent (Claude.exe) reads via Electron's IPC pipe. Microsoft's `tools/list` response is ~75 KB; it arrives at Claude in two chunks at the 64 KB Windows pipe buffer boundary, and Claude's parser treats each chunk as a separate (invalid) JSON-RPC message. Using `fs.writeSync` to fd 1 doesn't help — that file descriptor is not connected to Claude in `run-as-node` mode.

The launcher in this repo bypasses Microsoft's broken Node wrappers entirely and spawns the underlying `powerbi-modeling-mcp.exe` directly, while line-buffering its stdout so each complete MCP frame is delivered to Claude in a single `process.stdout.write` call. Diagnostic logging is written next to the launcher for troubleshooting.

When Microsoft fixes Bugs 2 and 3 upstream, the launcher in this repo can be simplified to just spawn the package's bin via Node — but the line-buffering / `process.stdout.write` glue for Electron is independent of Microsoft's bugs and likely to remain necessary.

## Repository layout

```
.
├── manifest.json           # MCPB manifest (declares prompts, server config)
├── server/
│   ├── index.js            # Launcher: spawns powerbi-modeling-mcp.exe and bridges stdio
│   ├── package.json        # Pulls @microsoft/powerbi-modeling-mcp as a dependency
│   └── node_modules/       # Created by `npm install` — not committed
├── .mcpbignore             # mcpb-pack ignore rules
├── .gitignore              # Standard ignores plus *.mcpb, launcher.log, node_modules/
├── LICENSE                 # MIT
└── README.md
```

## Prerequisites

- Windows 10/11 (the underlying `.exe` is `win32-x64`)
- [Claude Desktop](https://claude.ai/download) installed (MSIX package)
- [Node.js](https://nodejs.org/) 18+ (for `npm install` and the MCPB CLI; Claude Desktop uses its built-in Node at runtime)
- [Power BI Desktop](https://powerbi.microsoft.com/desktop/) for local model work, **or** a Microsoft Fabric workspace, **or** PBIP / TMDL files on disk

## Build and install

```powershell
# 1. Clone
git clone https://github.com/anzhe778/powerbi-modeling-mcp-claude.git
cd powerbi-modeling-mcp-claude

# 2. Install Microsoft's package + transitive deps into the bundle
cd server
npm install
cd ..

# 3. Install the MCPB packager (one-time, global)
npm install -g @anthropic-ai/mcpb

# 4. Pack the bundle
mcpb pack

# 5. Install in Claude Desktop:
#    Settings → Extensions → Advanced settings → Install Extension…
#    Pick the .mcpb that was just produced.
```

Quit Claude Desktop fully (system-tray icon → Quit) and reopen it. The extension should appear under **Settings → Extensions** as **Power BI Modeling MCP**.

## Usage

Open a Power BI Desktop file (or have a Fabric workspace handy) and in a regular Claude chat (not Cowork), type `/` to see the registered prompts, or just ask in natural language — for example:

- *"Connect to my Power BI Desktop file 'sales.pbix'."*
- *"List the tables in the model."*
- *"Show me the measures in `FACT_sales`."*
- *"Run this DAX query: `EVALUATE TOPN(10, 'FACT_sales')`."*
- *"Generate a Markdown doc of this model with a Mermaid relationship diagram."*

The first time the server modifies a model or runs a DAX query, you'll see an in-chat confirmation prompt (an MCP elicitation) before the action executes. **Always back up your `.pbix` before letting an agent make structural changes.** If you'd rather run in safe mode, append `"--readonly"` to the launcher's spawn args in `server/index.js`.

## Troubleshooting

The launcher writes structural events (start, child spawned, exit) to `<install-folder>/server/launcher.log`. On a Windows MSIX install the file lives under:

```
%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\Claude Extensions\local.mcpb.<author>.powerbi-modeling-mcp\server\launcher.log
```

(`<author>` and the package family-name suffix may differ on your machine; use `Get-AppxPackage` in PowerShell to find the exact path.)

### Verbose diagnostics

For deeper debugging — chunk-by-chunk stdin/stdout byte counts and content prefixes — set the environment variable `POWERBI_MCP_DEBUG=1` for Claude Desktop before launching it. With this enabled, the launcher logs every JSON-RPC frame's first 100–200 bytes plus length and write-ok status. This is useful when reporting an issue but should be left off in normal use because the log will contain DAX query text, table names, and other model content.

To set the env var for a Claude Desktop session in PowerShell:

```powershell
$env:POWERBI_MCP_DEBUG = "1"
# then launch Claude Desktop from the same shell
& "shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude"
```

(Plain `Start-Process Claude` won't always pass the env var into the MSIX container; the `shell:AppsFolder` invocation does.)

### Reporting an issue

If a tool call hangs or Claude reports "Server disconnected", attach the tail of `launcher.log` (with `POWERBI_MCP_DEBUG=1` for the failing run) plus the matching entries from Claude's developer settings log to a [GitHub issue](https://github.com/<you>/powerbi-modeling-mcp-claude/issues).

## Credits

- [Microsoft Power BI Modeling MCP](https://github.com/microsoft/powerbi-modeling-mcp) — the underlying server and `.exe`.
- [microsoft/powerbi-modeling-mcp issue #87](https://github.com/microsoft/powerbi-modeling-mcp/issues/87) — three-bug analysis that explained Microsoft's stdout pollution and silent-exit bugs.
- [modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb) — the MCPB bundle format and packing CLI.

## License

MIT — see [LICENSE](./LICENSE).

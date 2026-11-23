# Windows setup

Use Node.js 22.13 or newer, pnpm 9.4, current Google Chrome and a working
EvoMesh runtime. Use a checkout accessible only to the local operator for
the credential files. Run from an ordinary PowerShell in the LeadCollector
repository.

```powershell
corepack enable
corepack prepare pnpm@9.4.0 --activate
pnpm install --frozen-lockfile
pnpm build:api
pnpm build:extension
```

If Node does not ship Corepack, install pnpm 9.4.0 with
`npm install --global pnpm@9.4.0` instead. The extension folder after the
build is `apps/extension/dist`. It has `manifest.json` at its root.

## Provision and start

Choose the real EvoMesh workspace path. The example uses the playground
created for an agent named `lead-researcher`, under the default workspace.
You can omit `-ExportDirectory` for standalone operation.

```powershell
.\scripts\Start-LeadCollector.ps1 -Initialize -ExportDirectory 'C:\Dev\EvoMesh\workspace\agents\lead-researcher\playground\exports'
.\scripts\Start-LeadCollector.ps1
```

Initialization creates different random secrets in the git-ignored
`apps/api/.env` and writes client-only settings to `apps/api/.env.agent`.
Keep those files private. The default database directory is
`%LOCALAPPDATA%\EvoMesh\LeadCollector`. Use `-StateDirectory` and
`-Port` at initialization for custom settings. A configured port must
match in the backend, MCP config and extension. The start command runs
Node in the current terminal. Ctrl+C in that terminal stops it.

The operator can retrieve the worker token in a separate PowerShell with
`.\scripts\Start-LeadCollector.ps1 -ShowWorkerToken`. Paste it in the
extension's password field and click outside the field to save. Avoid
copying it into chat, transcripts, screenshots, shell arguments or tracked
files.

## EvoMesh and Chrome

1. In the EvoMesh checkout, run `.\scripts\install-chrome-bridge.ps1`. In
   the EvoMesh console, run `/browser start` for its dedicated Chrome.
2. Open `chrome://extensions` in that window, enable Developer mode and
   use **Load unpacked** for EvoMesh's `browser-extension` folder and
   LeadCollector's `apps/extension/dist` folder. This is a one-time
   action on the persistent automation profile. The LeadCollector ID in a
   build with the repository manifest key is
   `egdgjicbgiamheekmimkgmeligcipkco`.
3. In the LeadCollector popup, go to Settings. Set Backend URL to
   `http://127.0.0.1:5050` and paste the worker token. An authenticated
   check-in should appear within a Chrome alarm interval. Leave the
   personal browser profile outside this setup.
4. Spawn the companion template and add the MCP server to that agent only.
   Use forward slashes in absolute Windows paths entered in the console.

```text
/agent-template spawn lead-researcher lead-researcher
/browser grant lead-researcher read
/mcp add lead-researcher leadcollector node "C:/Dev/EvoMesh-LeadCollector/apps/api/mcp-server.mjs"
/mcp check leadcollector
/browser status
```

If you are running the packaged EvoMesh desktop instead of a source
checkout, install the template before spawning it with
`/agent-template install "C:/Dev/EvoMesh/agent-templates/lead-researcher"`
using the companion source checkout. Use that checkout for the browser
bridge installation files as well.

Use an absolute `node.exe` path if needed. For an explicit tool allowlist
and `McpServerConfig` example, see the companion setup guide. The optional
automation `interact` grant allows the agent to manage the dedicated
browser. The default `read` grant lets it run preflight while the operator
owns start and stop.

## Readiness and recovery

| Symptom | Check or action |
| --- | --- |
| API offline | Open the local backend terminal. `Invoke-RestMethod http://127.0.0.1:5050/` should return local liveness. Verify the port and build |
| MCP fails to connect | Use `/mcp check leadcollector`. Verify the Node executable, absolute script path, pnpm install and Node version |
| MCP reports unauthorized or missing credential | Match the agent token in `.env.agent` with the API's agent token and reload the MCP connection |
| DB not ready | Check startup output, the state directory ACL and free disk space. If SQLite reports busy, close other writers and wait for the lock or stop the duplicate backend |
| Bridge disconnected | Check `/browser status` and reopen the dedicated profile. Confirm native messaging registration and unpacked bridge installation |
| LeadCollector worker absent or stale | Check that LeadCollector is enabled in the automation profile, then confirm Backend URL and worker token. Allow about 30 seconds for an alarm. Health reports last seen time and extension version |
| Stale lease | Check job phase and attempt using MCP. Wait for the bounded retry. A superseded worker cannot submit to the new attempt |
| Cancelled or blocked | Inspect the terminal state and export any committed rows. The worker closes its own tab on the next successful reconciliation. Handle access prompts manually before requesting a fresh job |

To stop the dedicated Chrome, use `/browser stop`. To uninstall, remove
the LeadCollector extension in that profile and run
`/mcp remove lead-researcher leadcollector` in EvoMesh. Revoke its browser
grant if the agent is retired. Stop the backend before moving or deleting
its state directory. Copy any exports under that directory elsewhere
first. Exports in the configured EvoMesh playground are independent of the
database. Remove the local credential files when decommissioning the setup.

The script is provided for Windows PowerShell. Windows operator setup and
live Maps collection are manual acceptance steps. See
[the smoke test](SMOKE_TEST.md).

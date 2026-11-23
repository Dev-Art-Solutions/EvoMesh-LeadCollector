[CmdletBinding()]
param(
    [switch]$Initialize,
    [switch]$ShowWorkerToken,
    [ValidateRange(1, 65535)]
    [int]$Port = 5050,
    [string]$StateDirectory,
    [string]$ExportDirectory
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$api = Join-Path $repository 'apps/api'
$settings = Join-Path $api '.env'
$agentSettings = Join-Path $api '.env.agent'

function New-CollectorSecret {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Local-Path ([string]$Value) {
    return [System.IO.Path]::GetFullPath($Value).Replace('\', '/')
}

if ($Initialize) {
    if ((Test-Path $settings) -or (Test-Path $agentSettings)) {
        throw 'Local settings already exist. Edit them directly or back them up before reinitializing.'
    }
    if (-not $StateDirectory) { $StateDirectory = Join-Path $env:LOCALAPPDATA 'EvoMesh/LeadCollector' }
    if (-not $ExportDirectory) { $ExportDirectory = Join-Path $StateDirectory 'exports' }
    $statePath = Local-Path $StateDirectory
    $exportPath = Local-Path $ExportDirectory
    $agentToken = New-CollectorSecret
    $workerToken = New-CollectorSecret
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllLines($settings, [string[]]@(
        'HOST=127.0.0.1',
        "PORT=$Port",
        "LEADCOLLECTOR_AGENT_TOKEN=$agentToken",
        "LEADCOLLECTOR_WORKER_TOKEN=$workerToken",
        ('LEADCOLLECTOR_STATE_DIR="' + $statePath + '"'),
        ('LEADCOLLECTOR_EXPORT_DIR="' + $exportPath + '"')
    ), $utf8)
    [System.IO.File]::WriteAllLines($agentSettings, [string[]]@(
        "BACKEND_URL=http://127.0.0.1:$Port",
        "LEADCOLLECTOR_AGENT_TOKEN=$agentToken"
    ), $utf8)
    Write-Host 'Created local backend and MCP settings.'
    if (-not $ShowWorkerToken) { return }
}

if (-not (Test-Path $settings)) { throw 'Run this script with -Initialize first.' }
if ($ShowWorkerToken) {
    $line = Get-Content -LiteralPath $settings | Where-Object { $_ -match '^LEADCOLLECTOR_WORKER_TOKEN=' }
    if (-not $line) { throw 'No worker token in apps/api/.env.' }
    Write-Output ($line -replace '^LEADCOLLECTOR_WORKER_TOKEN=', '')
    return
}

$entry = Join-Path $api 'dist/main.js'
if (-not (Test-Path $entry)) { throw 'Run pnpm install --frozen-lockfile and pnpm build:api first.' }
& node $entry
exit $LASTEXITCODE

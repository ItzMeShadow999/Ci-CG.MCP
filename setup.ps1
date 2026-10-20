[CmdletBinding()]
param(
  [switch]$ReadOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Fail($msg)     { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

Step 0 'Checking files and tools'
foreach ($f in 'worker.js', 'wrangler.toml') {
  if (-not (Test-Path $f)) { Fail "$f not found. Run this script from the project folder." }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed. Get it from https://nodejs.org (LTS), then run this again.'
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail 'npx not found (it ships with Node.js).' }
Write-Host "Node $(node --version) found."

Step 1 'Cloudflare login'
$who = (& npx --yes wrangler whoami 2>&1 | Out-String)
if ($who -match 'not authenticated|You are not logged in') {
  Write-Host 'A browser window will open. Log in and click Allow.'
  & npx --yes wrangler login
  if ($LASTEXITCODE -ne 0) { Fail 'Cloudflare login failed.' }
} else {
  Write-Host 'Already logged in to Cloudflare.'
}

Step 2 'GitHub token'
$tokenUrl = 'https://github.com/settings/tokens/new?scopes=repo&description=commitment-issues-mcp'
Write-Host 'Opening GitHub. On that page:'
Write-Host '  - pick an expiration (your choice)'
Write-Host '  - leave the "repo" scope ticked'
Write-Host '  - click "Generate token" and copy it'
Start-Process $tokenUrl
$secure = Read-Host 'Paste your GitHub token here (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $ghToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrWhiteSpace($ghToken)) { Fail 'No token entered.' }
if ($ghToken -notmatch '^(ghp_|github_pat_|gho_|ghs_)') {
  Write-Host 'Warning: that does not look like a GitHub token, continuing anyway.' -ForegroundColor Yellow
}

try {
  $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers @{
    Authorization = "Bearer $ghToken"; 'User-Agent' = 'commitment-issues-setup'
  }
  Write-Host "Token works. Logged in to GitHub as: $($me.login)" -ForegroundColor Green
} catch {
  Fail 'GitHub rejected that token. Check that you copied all of it.'
}

Step 3 'Access key'
$keyFile = Join-Path $PSScriptRoot 'ACCESS_KEY.txt'
if (Test-Path $keyFile) {
  $accessKey = (Get-Content $keyFile -Raw).Trim()
  Write-Host 'Reusing existing ACCESS_KEY.txt.'
} else {
  $bytes = New-Object byte[] 24
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes); $rng.Dispose()
  $accessKey = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  [IO.File]::WriteAllText($keyFile, $accessKey, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Generated a new key and saved it to ACCESS_KEY.txt"
}

$gi = Join-Path $PSScriptRoot '.gitignore'
if (-not (Test-Path $gi) -or -not (Select-String -Path $gi -Pattern '^ACCESS_KEY\.txt$' -Quiet)) {
  Add-Content -Path $gi -Value 'ACCESS_KEY.txt'
}

Step 4 'Deploying your worker'
$deployArgs = @('--yes', 'wrangler', 'deploy')
if ($ReadOnly) { $deployArgs += @('--var', 'READ_ONLY:true') }
$deployOut = (& npx @deployArgs 2>&1 | Tee-Object -Variable deployLog | Out-String)
if ($LASTEXITCODE -ne 0) { Fail "Deploy failed. Output above." }
$workerUrl = $null
if ($deployOut -match 'https://[A-Za-z0-9.-]+\.workers\.dev') { $workerUrl = $Matches[0] }

Step 5 'Uploading secrets'
$tmp = Join-Path $env:TEMP ("ci-secrets-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  $json = @{ GITHUB_TOKEN = $ghToken; ACCESS_KEY = $accessKey } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  & npx --yes wrangler secret bulk $tmp
  if ($LASTEXITCODE -ne 0) { Fail 'Uploading secrets failed.' }
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  $ghToken = $null
}

if (-not $workerUrl) {
  $workerUrl = (Read-Host 'Could not detect your worker URL. Paste it (https://...workers.dev)').Trim().TrimEnd('/')
}
$mcpUrl = "$workerUrl/mcp/$accessKey"
try { Set-Clipboard -Value $mcpUrl } catch { }

Write-Host "`n=====================================================" -ForegroundColor Green
Write-Host ' DONE. Your MCP URL (also copied to your clipboard):' -ForegroundColor Green
Write-Host "`n  $mcpUrl`n"
Write-Host ' Add it in Claude: Settings > Connectors > Add custom connector,'
Write-Host ' paste the URL, then click Connect.'
Write-Host "`n Treat this URL like a password: anyone with it can use your GitHub token."
Write-Host ' Your key is saved in ACCESS_KEY.txt (git-ignored).'
Write-Host '=====================================================' -ForegroundColor Green

[CmdletBinding()]
param(
  [switch]$ReadOnly
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Fail($msg)     { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# ---- Where the project lives and where the files come from ----
$RepoRaw    = 'https://raw.githubusercontent.com/ItzMeShadow999/Ci-CG.MCP/main'
$RepoFiles  = 'README.md', 'setup.ps1', 'worker.js', 'wrangler.toml'
$ProjectDir = Join-Path $env:USERPROFILE 'Downloads\Ci-CG.MCP'   # = C:\Users\<you>\Downloads\Ci-CG.MCP

Step 0 'Downloading project files'
if (-not (Test-Path $ProjectDir)) { New-Item -ItemType Directory -Path $ProjectDir -Force | Out-Null }
foreach ($f in $RepoFiles) {
  $dest = Join-Path $ProjectDir $f
  # Don't overwrite this script while it is running from the same location
  if ($PSCommandPath -and ($PSCommandPath -eq $dest)) {
    Write-Host "Skipping $f (currently running)."
    continue
  }
  try {
    Invoke-WebRequest -Uri "$RepoRaw/$f" -OutFile $dest -UseBasicParsing
    Write-Host "Downloaded $f"
  } catch {
    Fail "Could not download $f from $RepoRaw. $($_.Exception.Message)"
  }
}
Set-Location -Path $ProjectDir
Write-Host "Project folder: $ProjectDir" -ForegroundColor Green

Step '0b' 'Checking files and tools'
foreach ($f in 'worker.js', 'wrangler.toml') {
  if (-not (Test-Path $f)) { Fail "$f is missing from $ProjectDir." }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed. Get it from https://nodejs.org (LTS), then run this again.'
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail 'npx not found (it ships with Node.js).' }
Write-Host "Node $(node --version) found."

Step 1 'Cloudflare login'
$who = (& npx --yes wrangler@latest whoami 2>&1 | Out-String)
if ($who -match 'not authenticated|You are not logged in') {
  Write-Host 'A browser window will open. Log in and click Allow.'
  & npx --yes wrangler@latest login
  if ($LASTEXITCODE -ne 0) { Fail 'Cloudflare login failed.' }
} else {
  Write-Host 'Already logged in to Cloudflare.'
}

Step 2 'GitHub token'
$allScopes = @(
  'repo','repo:status','repo_deployment','public_repo','repo:invite','security_events',
  'workflow','write:packages','read:packages','delete:packages',
  'admin:org','write:org','read:org','manage_runners:org',
  'admin:public_key','write:public_key','read:public_key',
  'admin:repo_hook','write:repo_hook','read:repo_hook','admin:org_hook',
  'gist','notifications','user','read:user','user:email','user:follow',
  'delete_repo','write:discussion','read:discussion',
  'admin:enterprise','manage_runners:enterprise','manage_billing:enterprise','read:enterprise','scim:enterprise',
  'audit_log','read:audit_log','codespace','codespace:secrets',
  'copilot','manage_billing:copilot',
  'write:network_configurations','read:network_configurations',
  'project','read:project',
  'admin:gpg_key','write:gpg_key','read:gpg_key',
  'admin:ssh_signing_key','write:ssh_signing_key','read:ssh_signing_key'
)
$scopeParam = [uri]::EscapeDataString($allScopes -join ',')
$tokenUrl = "https://github.com/settings/tokens/new?scopes=$scopeParam&description=commitment-issues-mcp"
Write-Host 'Opening GitHub. On that page:'
Write-Host '  - pick an expiration (your choice)'
Write-Host '  - all scopes are pre-ticked (leave them as they are)'
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
$keyFile = Join-Path $ProjectDir 'ACCESS_KEY.txt'
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

$gi = Join-Path $ProjectDir '.gitignore'
if (-not (Test-Path $gi) -or -not (Select-String -Path $gi -Pattern '^ACCESS_KEY\.txt$' -Quiet)) {
  Add-Content -Path $gi -Value 'ACCESS_KEY.txt'
}

Step 4 'Deploying your worker'
$deployArgs = @('--yes', 'wrangler@latest', 'deploy')
if ($ReadOnly) { $deployArgs += @('--var', 'READ_ONLY:true') }
$deployOut = (& npx @deployArgs 2>&1 | ForEach-Object { Write-Host $_; $_ } | Out-String)
if ($LASTEXITCODE -ne 0) {
  if ($deployOut -match 'workers\.dev subdomain') {
    Write-Host "`nHint: open https://dash.cloudflare.com > Workers & Pages once and pick a workers.dev subdomain, then run this again." -ForegroundColor Yellow
  } elseif ($deployOut -match 'more than one account|CLOUDFLARE_ACCOUNT_ID') {
    Write-Host "`nHint: you have several Cloudflare accounts. Run:  `$env:CLOUDFLARE_ACCOUNT_ID = 'your-account-id'  then run this again." -ForegroundColor Yellow
  } elseif ($deployOut -match 'Authentication error|10000|not authenticated') {
    Write-Host "`nHint: Cloudflare login is missing or expired. Run:  npx wrangler@latest login  then run this again." -ForegroundColor Yellow
  }
  Fail 'Deploy failed. See the wrangler output printed above.'
}
$workerUrl = $null
if ($deployOut -match 'https://[A-Za-z0-9.-]+\.workers\.dev') { $workerUrl = $Matches[0] }

Step 5 'Uploading secrets'
$tmp = Join-Path $env:TEMP ("ci-secrets-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  $json = @{ GITHUB_TOKEN = $ghToken; ACCESS_KEY = $accessKey } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  & npx --yes wrangler@latest secret bulk $tmp
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

# Janus Agent Installer for Windows
# Usage: powershell -c "irm https://raw.githubusercontent.com/wtokarzewski/janus-agent/main/scripts/install.ps1 | iex"

$ErrorActionPreference = "Stop"

$Repo = "wtokarzewski/janus-agent"
$InstallDir = "$env:LOCALAPPDATA\janus-agent"
$BinDir = "$env:LOCALAPPDATA\janus-agent\bin"

function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Warn($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# --- Prerequisites ---

try { $nodeVersion = (node --version) } catch { Write-Err "Node.js is required but not found. Install Node.js 20+ from https://nodejs.org" }
$major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
if ($major -lt 20) { Write-Err "Node.js 20+ is required (found $nodeVersion). Update from https://nodejs.org" }

try { npm --version | Out-Null } catch { Write-Err "npm is required but not found." }

# --- Detect latest release ---

Write-Info "Fetching latest release..."
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = "application/vnd.github+json" }
} catch {
    Write-Err "Could not reach GitHub API. Check your internet connection."
}

$tag = $release.tag_name
if (-not $tag) { Write-Err "No releases found." }

$asset = $release.assets | Where-Object { $_.name -like "*.tar.gz" } | Select-Object -First 1
if (-not $asset) { Write-Err "No tarball asset found in release $tag." }

$version = $tag -replace '^v', ''
Write-Info "Installing Janus v$version..."

# --- Download ---

$tmpFile = Join-Path $env:TEMP "janus-v$version.tar.gz"
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpFile -UseBasicParsing
} catch {
    Write-Err "Download failed."
}

# --- Backup and extract ---

if (Test-Path $InstallDir) {
    $backupDir = "${InstallDir}.bak"
    if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }
    Write-Warn "Existing installation found. Backing up..."
    Rename-Item $InstallDir $backupDir
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
tar xzf $tmpFile --strip-components=1 -C $InstallDir
if ($LASTEXITCODE -ne 0) { Write-Err "Extraction failed." }

# --- Install dependencies ---

Write-Info "Installing dependencies..."
Push-Location $InstallDir
try {
    npm install --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} catch {
    Write-Err "npm install failed."
} finally {
    Pop-Location
}

# --- Create launcher ---

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$launcherContent = @"
@echo off
npx --prefix "%LOCALAPPDATA%\janus-agent" tsx "%LOCALAPPDATA%\janus-agent\src\index.ts" %*
"@
Set-Content -Path "$BinDir\janus.cmd" -Value $launcherContent -Encoding ASCII

# --- Ensure PATH ---

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$BinDir;$userPath", "User")
    $env:PATH = "$BinDir;$env:PATH"
    Write-Warn "Added $BinDir to user PATH"
}

# --- Cleanup ---

Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue

# --- Done ---

Write-Host ""
Write-Ok "Janus v$version installed successfully!"
Write-Host ""
Write-Host "  Location:  $InstallDir"
Write-Host "  Command:   janus"
Write-Host ""
Write-Host "  Get started:"
Write-Host "    janus onboard    # Initialize workspace"
Write-Host "    janus setup      # Configure LLM provider"
Write-Host "    janus            # Start interactive CLI"
Write-Host ""

try { janus --version | Out-Null } catch {
    Write-Warn "Note: Restart your terminal to use the 'janus' command."
}

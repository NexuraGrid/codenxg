# Installs the latest CodeNXG release for Windows x64.
# Usage: irm https://raw.githubusercontent.com/NexuraGrid/codenxg/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "NexuraGrid/codenxg"
$arch = $env:PROCESSOR_ARCHITECTURE

if ($arch -notmatch "^(AMD64|x86_64)$") {
    Write-Error "This script only supports Windows x64 right now. Grab your platform's build from https://github.com/$repo/releases/latest"
    exit 1
}

Write-Host "Fetching latest release info..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "codenxg-installer" }

$asset = $release.assets | Where-Object { $_.name -like "*x64-setup.exe" } | Select-Object -First 1

if (-not $asset) {
    Write-Error "Could not find a Windows installer asset in the latest release."
    exit 1
}

$installer = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.browser_download_url)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer

Write-Host "Running installer..."
Start-Process -FilePath $installer -ArgumentList "/S" -Wait

Remove-Item $installer -ErrorAction SilentlyContinue

Write-Host "CodeNXG installed. Launch it from the Start Menu, or run 'codenxg' from a new terminal."

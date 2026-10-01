param([string]$Directory = (Join-Path $env:LOCALAPPDATA 'Janus\voice'))
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Directory = [IO.Path]::GetFullPath($Directory)
if (Test-Path $Directory) { throw "Destination already exists: $Directory. Choose a new -Directory; existing files will not be overwritten." }
$parent = Split-Path $Directory -Parent
New-Item -ItemType Directory -Force $parent | Out-Null
$staging = Join-Path $parent ('voice-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $staging | Out-Null
function Get-PinnedFile([string]$Url, [string]$Path, [string]$Hash) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
    if ((Get-FileHash -Algorithm SHA256 $Path).Hash.ToLowerInvariant() -ne $Hash) {
        throw "Checksum mismatch: $([IO.Path]::GetFileName($Path))"
    }
}
try {
    Get-PinnedFile 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip' (Join-Path $staging 'engine.zip') '0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9'
    Get-PinnedFile 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip' (Join-Path $staging 'converter.zip') '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
    Get-PinnedFile 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' (Join-Path $staging 'ggml-base.bin') '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
    Expand-Archive (Join-Path $staging 'engine.zip') (Join-Path $staging 'engine')
    Expand-Archive (Join-Path $staging 'converter.zip') (Join-Path $staging 'converter')
    # Preserve complete distributions, bundled notices and verified download archives.
    $engine = @(Get-ChildItem (Join-Path $staging 'engine') -Recurse -Filter 'whisper-cli.exe')
    $converter = @(Get-ChildItem (Join-Path $staging 'converter') -Recurse -Filter 'ffmpeg.exe')
    if ($engine.Count -ne 1 -or $converter.Count -ne 1) { throw 'Unexpected archive layout' }
    $engineRelative = $engine[0].FullName.Substring($staging.Length + 1)
    $converterRelative = $converter[0].FullName.Substring($staging.Length + 1)
    $config = @{ voice = @{
        enabled = $true; provider = 'local'; language = 'pl'; maxDurationSec = 60; maxFileSizeMb = 20
        local = @{
            executablePath = (Join-Path $Directory $engineRelative)
            converterPath = (Join-Path $Directory $converterRelative)
            modelPath = (Join-Path $Directory 'ggml-base.bin')
            threads = 2; timeoutMs = 120000; maxQueuedJobs = 4; maxQueueWaitMs = 120000
        }
    } }
    $json = $config | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $staging 'voice-config.json'), $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item $staging $Directory
    Write-Output "Installed local voice tools in $Directory"
    Write-Output 'Merge the voice section below into your existing janus.json. Do not replace the whole configuration.'
    Write-Output $json
} finally {
    if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}

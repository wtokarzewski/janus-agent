# Explicit real-engine smoke test. Runs in a temporary workspace with synthetic speech.
param([Parameter(Mandatory=$true)][string]$ToolsDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('janus-voice-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $testDir | Out-Null
try {
    $config = Get-Content (Join-Path $ToolsDirectory 'voice-config.json') -Raw | ConvertFrom-Json
    $config.voice.language = 'en'
    [IO.File]::WriteAllText((Join-Path $testDir 'janus.json'), ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Add-Type -AssemblyName System.Speech
    $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $speech.SetOutputToWaveFile((Join-Path $testDir 'sample.wav'))
        $speech.Speak('Please remember the meeting tomorrow. Do not change the date.')
    } finally { $speech.Dispose() }
    foreach ($format in @('ogg', 'mp3')) {
        $inputPath = Join-Path $testDir 'sample.wav'
        $outputPath = Join-Path $testDir "sample.$format"
        & $config.voice.local.converterPath -nostdin -hide_banner -loglevel error -i $inputPath $outputPath
        if ($LASTEXITCODE -ne 0) { throw "Failed to create $format fixture" }
    }
    Push-Location $testDir
    try {
        foreach ($format in @('wav', 'ogg', 'mp3')) {
            & node (Join-Path $repo 'node_modules/tsx/dist/cli.mjs') (Join-Path $repo 'src/index.ts') voice-check --audio (Join-Path $testDir "sample.$format") --expect 'please remember' --show-text
            if ($LASTEXITCODE -ne 0) { throw "Real local transcription failed for $format" }
        }
    } finally { Pop-Location }
} finally {
    if (Test-Path $testDir) { Remove-Item -LiteralPath $testDir -Recurse -Force }
}

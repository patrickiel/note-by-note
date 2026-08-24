<#
.SYNOPSIS
    Burns promo/captions.srt into the screencast and writes a NEW mp4.
    The source recording is never modified.

.DESCRIPTION
    Edit the text and timings in captions.srt, then re-run this script. Nothing
    else needs to change — styling, font size and margins are all parameters
    here, and the caption content lives entirely in the .srt.

    Fine-tuning workflow:
      1. -Soft            mux the subs as a switchable track, no re-encode (~2 s).
                          Scrub it in VLC/mpv to check timings fast.
      2. -Preview 47 -Duration 10
                          burn just that window so you can eyeball styling.
      3. (no flags)       full burn-in for upload.

.PARAMETER Soft
    Mux the captions as a soft (toggleable) mov_text track instead of burning
    them into the pixels. Stream-copies, so it is near-instant — the fastest way
    to check whether your timestamps line up. Not suitable for Reddit/X upload,
    where captions must be burned in.

.PARAMETER Preview
    Start time (seconds, or hh:mm:ss) of a short test render. Writes to
    <output>-preview.mp4 so it never clobbers the real render.

.PARAMETER Duration
    Length in seconds of the -Preview render. Default 10.

.PARAMETER Height
    Scale the output to this height, preserving aspect (e.g. 1080). 0 = keep the
    native 1510 px. Captions are rendered after scaling, so they stay crisp.

.PARAMETER FontSize
    Caption height in output pixels. 0 = auto (9.5% of the frame height, ~143 px
    at the native 1510) - sized to stay readable in a phone-sized feed.

.PARAMETER MarginV
    Distance from the bottom edge, same units. 0 = auto (5% of height).

.PARAMETER Box
    Draw captions on an opaque rounded box instead of outline + drop shadow.
    Easier to read over busy footage; heavier looking.

.EXAMPLE
    .\apply-captions.ps1 -Soft
    Quick timing check — no re-encode.

.EXAMPLE
    .\apply-captions.ps1 -Preview 47 -Duration 12
    Render just the looper section to check the caption copy in context.

.EXAMPLE
    .\apply-captions.ps1 -Height 1080
    Final upload render, downscaled to 1080p.
#>
[CmdletBinding()]
param(
    [string] $InputVideo  = "$PSScriptRoot\screencast.mp4",
    [string] $Captions    = "$PSScriptRoot\captions.srt",
    [string] $OutputVideo = "$PSScriptRoot\screencast-captioned.mp4",

    [switch] $Soft,
    [string] $Preview,
    [double] $Duration = 10,

    [int]    $Height   = 0,
    [int]    $FontSize = 0,
    [int]    $MarginV  = 0,
    [switch] $Box,

    [string] $Font        = 'Segoe UI',
    [string] $TextColor   = '#f0e9db',
    [string] $ShadeColor  = '#161310',
    [int]    $Crf         = 20,
    [string] $Preset      = 'medium'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

foreach ($exe in 'ffmpeg', 'ffprobe') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Fail "$exe is not on PATH. Install it (choco install ffmpeg) and retry."
    }
}
if (-not (Test-Path -LiteralPath $InputVideo)) { Fail "No such video: $InputVideo" }
if (-not (Test-Path -LiteralPath $Captions))   { Fail "No such captions file: $Captions" }

$InputVideo  = (Resolve-Path -LiteralPath $InputVideo).Path
$Captions    = (Resolve-Path -LiteralPath $Captions).Path

# --- Soft-sub path: stream copy, no filtering, no styling. -------------------
if ($Soft) {
    $softOut = [IO.Path]::ChangeExtension($OutputVideo, $null).TrimEnd('.') + '-soft.mp4'
    Write-Host "Muxing soft subtitles -> $softOut" -ForegroundColor Cyan
    & ffmpeg -hide_banner -loglevel warning -stats -y `
        -i $InputVideo -i $Captions `
        -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=eng `
        $softOut
    if ($LASTEXITCODE -ne 0) { Fail "ffmpeg failed (exit $LASTEXITCODE)." }
    Write-Host "Done. Open it in VLC or mpv and turn subtitles on." -ForegroundColor Green
    exit 0
}

# --- Probe so font size / margins can scale with the output resolution. ------
$dims = (& ffprobe -v error -select_streams v:0 -show_entries stream=width,height `
                   -of csv=s=x:p=0 $InputVideo).Trim()
$srcW, $srcH = $dims -split 'x' | ForEach-Object { [int]$_ }

if ($Height -gt 0) {
    $outH = $Height
    # -2 keeps the aspect ratio and forces an even width (libx264 requires it).
    $outW = [math]::Round($srcW * ($outH / $srcH))
} else {
    $outH = $srcH
    $outW = $srcW
}
if ($FontSize -le 0) { $FontSize = [math]::Round($outH * 0.095) }
if ($MarginV  -le 0) { $MarginV  = [math]::Round($outH * 0.05) }
$marginH = [math]::Round($outW * 0.04)

# ASS colours are &HAABBGGRR — alpha first, then blue/green/red (not RGB).
function ConvertTo-AssColor([string] $hex, [int] $alpha = 0) {
    $h = $hex.TrimStart('#')
    if ($h.Length -ne 6) { Fail "Colour must be #rrggbb, got '$hex'." }
    '&H{0:X2}{1}{2}{3}' -f $alpha, $h.Substring(4, 2), $h.Substring(2, 2), $h.Substring(0, 2)
}

$primary = ConvertTo-AssColor $TextColor
if ($Box) {
    # BorderStyle=3 fills the text box with BackColour; Outline is the padding.
    $style = "BorderStyle=3,Outline=8,Shadow=0,BackColour=$(ConvertTo-AssColor $ShadeColor 40)"
} else {
    $style = "BorderStyle=1,Outline=3,Shadow=2," +
             "OutlineColour=$(ConvertTo-AssColor $ShadeColor)," +
             "BackColour=$(ConvertTo-AssColor '#000000' 128)"
}

$forceStyle = "FontName=$Font,FontSize=$FontSize,Bold=1,PrimaryColour=$primary,$style," +
              "Alignment=2,MarginV=$MarginV,MarginL=$marginH,MarginR=$marginH"

# The filtergraph parser chokes on Windows drive letters and backslashes, so run
# ffmpeg from a temp dir holding the subtitles under a plain relative name.
# Input/output paths are ordinary args and need no escaping.
$work = Join-Path ([IO.Path]::GetTempPath()) ('nbn-captions-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$assPath = Join-Path $work 'subs.ass'

# ffmpeg's SRT->ASS conversion hardcodes a 384x288 script resolution, which would
# make every size above a fraction of the frame rather than a pixel count.
# Convert up front and rewrite PlayRes to the output size, so -FontSize/-MarginV
# are honest output pixels.
& ffmpeg -hide_banner -loglevel error -y -i $Captions $assPath
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Fail "Could not parse $Captions - check the SRT timestamp format (hh:mm:ss,mmm --> hh:mm:ss,mmm)."
}
# -Encoding UTF8 on the read is load-bearing: ffmpeg emits UTF-8 without a BOM,
# and Windows PowerShell would otherwise decode it as ANSI and turn every em dash
# into mojibake.
(Get-Content -LiteralPath $assPath -Encoding UTF8) `
    -replace '^PlayResX:.*', "PlayResX: $outW" `
    -replace '^PlayResY:.*', "PlayResY: $outH" |
    Set-Content -LiteralPath $assPath -Encoding UTF8

$filters = @()
if ($Height -gt 0) { $filters += "scale=-2:$outH" }   # scale first: crisper text
$filters += "subtitles=subs.ass:force_style='$forceStyle'"
$vf = $filters -join ','

$target = $OutputVideo
$trim   = @()
if ($Preview) {
    $target = [IO.Path]::ChangeExtension($OutputVideo, $null).TrimEnd('.') + '-preview.mp4'
    # -ss/-t AFTER -i is an output seek: frames still reach the filter graph with
    # their original timestamps, so captions land where the .srt says they do.
    $trim = @('-ss', $Preview, '-t', $Duration)
}

Write-Host "Burning captions -> $target" -ForegroundColor Cyan
Write-Host "  $outW x $outH, font $FontSize pt, margin $MarginV" -ForegroundColor DarkGray

Push-Location $work
try {
    & ffmpeg -hide_banner -loglevel warning -stats -y `
        -i $InputVideo @trim `
        -vf $vf `
        -c:v libx264 -crf $Crf -preset $Preset -pix_fmt yuv420p `
        -movflags +faststart `
        -c:a aac -b:a 192k `
        $target
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($code -ne 0) { Fail "ffmpeg failed (exit $code)." }

$mb = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1)
Write-Host "Done: $target ($mb MB)" -ForegroundColor Green

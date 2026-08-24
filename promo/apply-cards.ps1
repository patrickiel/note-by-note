<#
.SYNOPSIS
    Wraps the captioned screencast in its animated bookend cards — intro.html
    in front, outro.html at the end. Neither input is modified.

.DESCRIPTION
    Per card:

      1. capture-card.mjs steps the card's CSS animations frame by frame in
         headless Chrome and writes a PNG per frame (~1.3 s of card, ~20 s of
         wall clock each). It also refreshes the settled stills, intro.png and
         outro.png.
      2. ffmpeg encodes those frames, holds the last one, and fades the card up
         from black and back down.

    Then all three parts are concatenated with a stream copy, so the screencast
    itself is never re-encoded and caption timings stay relative to their own
    footage.

    Run it after apply-captions.ps1. The result, screencast-promo.mp4, is the
    file to upload.

.PARAMETER Settle
    Seconds of animation captured per card — long enough for the last entrance
    to finish. Default 1.35; both cards settle at ~1.25 s.

.PARAMETER Hold
    Seconds the settled intro sits still before it starts fading. Default 0.55.

.PARAMETER OutroHold
    Same for the outro, which carries the call to action and so needs long
    enough to read. Default 1.2.

.PARAMETER FadeIn
    Fade-up from black, in seconds. Default 0.35 — it overlaps the entrances,
    so a card arrives rather than appearing and then animating.

.PARAMETER FadeOut
    Fade-down to black, in seconds. Default 0.4. Intro = Settle + Hold +
    FadeOut (~2.3 s); outro = Settle + OutroHold + FadeOut (~3 s).

.PARAMETER CardsOnly
    Refresh intro.png and outro.png (the settled stills, useful as thumbnails)
    and stop. The fast loop while iterating on the card art.

.PARAMETER ChromePath
    Chrome to render with. Default: the Chrome for Testing under .browsers,
    which capture-card.mjs finds on its own.

.EXAMPLE
    .\apply-cards.ps1 -CardsOnly
    Redraw both stills to check the art without touching video.

.EXAMPLE
    .\apply-cards.ps1
    Build screencast-promo.mp4 = intro + captioned screencast + outro.
#>
[CmdletBinding()]
param(
    [string] $InputVideo  = "$PSScriptRoot\screencast-captioned.mp4",
    [string] $OutputVideo = "$PSScriptRoot\screencast-promo.mp4",

    [switch] $CardsOnly,

    [double] $Settle    = 1.35,
    [double] $Hold      = 0.55,
    [double] $OutroHold = 1.2,
    [double] $FadeIn    = 0.35,
    [double] $FadeOut   = 0.4,

    [string] $ChromePath,
    [int]    $Crf    = 20,
    [string] $Preset = 'medium'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

$capture = Join-Path $PSScriptRoot 'capture-card.mjs'
if (-not (Test-Path -LiteralPath $capture)) { Fail "Missing $capture" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node is not on PATH.' }
if ($ChromePath) { $env:CHROME_PATH = $ChromePath }

# --- Stills: the settled cards, kept around as thumbnails. -------------------
foreach ($card in 'intro', 'outro') {
    $png = Join-Path $PSScriptRoot "$card.png"
    Write-Host "Rendering still -> $png" -ForegroundColor Cyan
    & node $capture --card $card --still $png | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "capture-card.mjs failed on $card (exit $LASTEXITCODE)." }
}

if ($CardsOnly) { Write-Host 'Done (stills only).' -ForegroundColor Green; exit 0 }

# --- Probe the screencast so the cards are encoded to match. -----------------
foreach ($exe in 'ffmpeg', 'ffprobe') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Fail "$exe is not on PATH. Install it (choco install ffmpeg) and retry."
    }
}
if (-not (Test-Path -LiteralPath $InputVideo)) {
    Fail "No such video: $InputVideo (run apply-captions.ps1 first)."
}
$InputVideo = (Resolve-Path -LiteralPath $InputVideo).Path

$probe = (& ffprobe -v error -select_streams v:0 `
            -show_entries stream=width,height,r_frame_rate -of csv=s=,:p=0 $InputVideo).Trim()
$w, $h, $rate = $probe -split ','
$num, $den = $rate -split '/'
$fps = [math]::Round([double]$num / [double]$den, 3)

$frames = [int][math]::Ceiling($Settle * $fps)

$work = Join-Path ([IO.Path]::GetTempPath()) ('nbn-cards-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$listFile = Join-Path $work 'list.txt'

# Captures `card`, encodes it to match the screencast, returns its duration.
function Build-Card([string] $card, [double] $hold, [string] $target) {
    $frameDir = Join-Path $work "$card-frames"
    New-Item -ItemType Directory -Path $frameDir -Force | Out-Null

    Write-Host "Capturing $frames frames of $card animation" -ForegroundColor Cyan
    & node $capture --card $card --out $frameDir --frames $frames --fps $fps | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "capture-card.mjs failed on $card (exit $LASTEXITCODE)." }

    $tail  = $hold + $FadeOut       # held on the last captured frame
    $total = $frames / $fps + $tail
    $outAt = $total - $FadeOut

    # tpad clones the last frame for the hold and the fade-out, so those seconds
    # cost nothing to capture. Letterboxing (rather than stretching) in the
    # card's own background colour keeps a differently sized recording clean.
    # anullsrc gives the card a silent track: concat needs every part to carry
    # the same streams, and a video-only segment drops the audio.
    $vf = "tpad=stop_mode=clone:stop_duration=$tail," +
          "scale=$($w):$($h):force_original_aspect_ratio=decrease," +
          "pad=$($w):$($h):(ow-iw)/2:(oh-ih)/2:color=0x0e0c09," +
          "fade=t=in:st=0:d=$FadeIn,fade=t=out:st=$outAt`:d=$FadeOut,format=yuv420p"

    Write-Host "Encoding $([math]::Round($total, 2)) s $card card ($w x $h, $fps fps)" -ForegroundColor Cyan
    & ffmpeg -hide_banner -loglevel warning -stats -y `
        -framerate $fps -start_number 0 -i (Join-Path $frameDir '%03d.png') `
        -f lavfi -t $total -i anullsrc=channel_layout=stereo:sample_rate=48000 `
        -vf $vf -r $fps `
        -c:v libx264 -crf $Crf -preset $Preset -pix_fmt yuv420p `
        -c:a aac -b:a 192k -shortest `
        $target
    if ($LASTEXITCODE -ne 0) { Fail "ffmpeg failed encoding the $card card (exit $LASTEXITCODE)." }

    return $total
}

try {
    $introClip = Join-Path $work 'intro.mp4'
    $outroClip = Join-Path $work 'outro.mp4'
    $added  = Build-Card 'intro' $Hold      $introClip
    $added += Build-Card 'outro' $OutroHold $outroClip

    # Written through .NET rather than Set-Content: Windows PowerShell's UTF8
    # encoding emits a BOM, and ffmpeg reads it as part of the first keyword.
    $q = "'"
    $list = ($introClip, $InputVideo, $outroClip | ForEach-Object { "file $q$_$q" }) -join "`n"
    [IO.File]::WriteAllText($listFile, $list, (New-Object Text.UTF8Encoding $false))

    Write-Host "Splicing -> $OutputVideo" -ForegroundColor Cyan
    & ffmpeg -hide_banner -loglevel warning -stats -y `
        -f concat -safe 0 -i $listFile -c copy -movflags +faststart `
        $OutputVideo
    if ($LASTEXITCODE -ne 0) { Fail "ffmpeg failed concatenating (exit $LASTEXITCODE)." }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# A stream copy only works if the parts really do agree on codec settings; a
# mismatch usually shows up as a truncated result rather than an error.
$srcLen = [double](& ffprobe -v error -show_entries format=duration -of csv=p=0 $InputVideo)
$outLen = [double](& ffprobe -v error -show_entries format=duration -of csv=p=0 $OutputVideo)
if ([math]::Abs($outLen - ($srcLen + $added)) -gt 0.5) {
    Write-Host "WARNING: expected $([math]::Round($srcLen + $added, 2)) s, got $([math]::Round($outLen, 2)) s - check the splice." -ForegroundColor Yellow
}

$mb = [math]::Round((Get-Item -LiteralPath $OutputVideo).Length / 1MB, 1)
Write-Host "Done: $OutputVideo ($([math]::Round($outLen, 1)) s, $mb MB)" -ForegroundColor Green

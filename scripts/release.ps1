<#
.SYNOPSIS
  Cut a release: verify the tree, bump the version, build the store zips, tag and push.

.EXAMPLE
  pnpm release:dry                       # show the plan, change nothing
  pnpm release                           # patch: 1.0.0 -> 1.0.1
  .\scripts\release.ps1 -Bump minor      # 1.0.0 -> 1.1.0
  .\scripts\release.ps1 -Version 2.0.0   # explicit
#>
[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',
  # Explicit version, e.g. 1.2.0. Overrides -Bump.
  [string]$Version,
  # Skip `pnpm check` and `pnpm test:dsp`.
  [switch]$SkipTests,
  # Print the plan and stop before touching anything.
  [switch]$DryRun,
  # Release from a branch other than main.
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkgPath = Join-Path $root 'package.json'
# Set once the new version is on disk but not yet committed, so any later
# failure puts package.json back the way it was.
$bumped = $false

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Fail($m) {
  if ($bumped) {
    Write-Host '    Reverting the version bump.' -ForegroundColor Yellow
    git checkout -- $pkgPath
  }
  Write-Host "!!! $m" -ForegroundColor Red
  exit 1
}

function Run($exe, $exeArgs) {
  Write-Host "    $exe $($exeArgs -join ' ')" -ForegroundColor DarkGray
  & $exe @exeArgs
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($exeArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

# --- 1. Preflight: branch, clean tree, in sync with origin -------------------
Step 'Checking the working tree'

$current = (git rev-parse --abbrev-ref HEAD).Trim()
if ($current -ne $Branch) { Fail "On branch '$current', expected '$Branch'. Use -Branch $current to override." }

if ((git status --porcelain)) {
  git status --short
  Fail 'Uncommitted changes. Commit or stash them first.'
}

git fetch origin --tags --quiet
if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed.' }

$counts = (git rev-list --left-right --count "origin/$Branch...HEAD").Trim() -split '\s+'
$behind = [int]$counts[0]
$ahead = [int]$counts[1]
if ($behind -gt 0) { Fail "Local $Branch is $behind commit(s) behind origin/$Branch. Pull first." }
if ($ahead -gt 0) { Write-Host "    $ahead unpushed commit(s): they go out with this release." -ForegroundColor Yellow }
Write-Host '    Clean, up to date.' -ForegroundColor Green

# --- 2. Work out the new version --------------------------------------------
$pkgText = Get-Content $pkgPath -Raw
$versionRe = [regex]'(?m)^(?<pre>\s*"version":\s*")(?<v>\d+\.\d+\.\d+)(?<post>")'
$found = $versionRe.Match($pkgText)
if (-not $found.Success) { Fail 'No "version": "x.y.z" found in package.json.' }

$old = $found.Groups['v'].Value
if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "-Version must be x.y.z, got '$Version'." }
  $new = $Version
}
else {
  $parts = $old -split '\.'
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  $patch = [int]$parts[2]
  switch ($Bump) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    'patch' { $patch++ }
  }
  $new = "$major.$minor.$patch"
}
$tag = "v$new"

if ($new -eq $old) { Fail "Version is already $old." }
if ((git tag --list $tag)) { Fail "Tag $tag already exists." }

Step "Release $old -> $new  (tag $tag)"
if ($DryRun) {
  Write-Host '    Would run:' -ForegroundColor Yellow
  Write-Host '      pnpm check ; pnpm test:dsp' -ForegroundColor Yellow
  Write-Host "      set package.json version to $new" -ForegroundColor Yellow
  Write-Host '      pnpm zip ; pnpm zip:firefox' -ForegroundColor Yellow
  Write-Host "      git commit -m 'Release $tag' ; git tag -a $tag ; git push origin $Branch --follow-tags" -ForegroundColor Yellow
  Write-Host "      claude -p (release notes per scripts/release-notes-instructions.md)" -ForegroundColor Yellow
  Write-Host "      gh release create $tag (with the notes and zips attached)" -ForegroundColor Yellow
  exit 0
}

# --- 3. Gates ----------------------------------------------------------------
if ($SkipTests) {
  Write-Host '    Skipping check/tests (-SkipTests).' -ForegroundColor Yellow
}
else {
  Step 'Type check'
  Run 'pnpm' @('check')
  Step 'DSP tests'
  Run 'pnpm' @('test:dsp')
}

# --- 4. Bump + build the store zips -----------------------------------------
Step "Writing version $new to package.json"
$updated = $versionRe.Replace($pkgText, "`${pre}$new`${post}", 1)
[IO.File]::WriteAllText($pkgPath, $updated)
$bumped = $true

# `wxt zip` reruns build:before, so the worklet bundles are rebuilt here.
Step 'Building Chrome zip'
Run 'pnpm' @('zip')
Step 'Building Firefox zip (plus the sources zip AMO requires)'
Run 'pnpm' @('zip:firefox')

# --- 5. Commit, tag, push ----------------------------------------------------
Step 'Committing, tagging, pushing'
Run 'git' @('add', 'package.json')
Run 'git' @('commit', '-m', "Release $tag")
# Committed: the bump is history now, nothing left to revert.
$bumped = $false
Run 'git' @('tag', '-a', $tag, '-m', "Release $tag")
Run 'git' @('push', 'origin', $Branch, '--follow-tags')

# --- 6. GitHub release with the zips attached ---------------------------------
# Notes are written by Claude from the commit log, following the fixed format in
# scripts/release-notes-instructions.md; falls back to GitHub's auto-notes.
Step 'Generating release notes'
$notesArgs = @('--generate-notes')
$prevTag = git tag --sort=-v:refname --list 'v*' | Where-Object { $_ -ne $tag } | Select-Object -First 1
$range = if ($prevTag) { "$prevTag..$tag" } else { $tag }
$commits = (git log $range --no-merges --pretty='format:%s%n%b----') -join "`n"
$instructions = Get-Content (Join-Path $PSScriptRoot 'release-notes-instructions.md') -Raw
# UTF-8 both ways across the pipe - PS 5.1 otherwise mangles non-ASCII (em dashes etc.).
$prevOutEnc = [Console]::OutputEncoding; $prevPipeEnc = $OutputEncoding
[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8
$notes = "$instructions`nCommits in this release ($range), separated by ----:`n`n$commits" | claude -p
[Console]::OutputEncoding = $prevOutEnc; $OutputEncoding = $prevPipeEnc
$notesText = (($notes -join "`n").Trim())
# Drop any preamble before the first section heading (the format demands none,
# but published notes must never contain model chatter).
if ($notesText -match '(?ms)^.*?(?=^## )') { $notesText = $notesText.Substring($Matches[0].Length) }
if ($LASTEXITCODE -eq 0 -and $notesText -match '^(## |Maintenance release)') {
  $notesFile = Join-Path $root ".output\release-notes-$new.md"
  [IO.File]::WriteAllText($notesFile, $notesText + "`n")
  # Plain-text twin for the stores' "what's new" fields (they don't render Markdown).
  $plainText = ($notesText -replace '(?m)^##\s+', '' -replace '\*\*', '')
  [IO.File]::WriteAllText((Join-Path $root ".output\release-notes-$new.txt"), $plainText + "`n")
  Write-Host ($notesText -replace '(?m)^', '    ') -ForegroundColor DarkGray
  $notesArgs = @('--notes-file', $notesFile)
}
else {
  Write-Host '    claude -p failed - falling back to GitHub auto-generated notes.' -ForegroundColor Yellow
}

Step 'Creating the GitHub release'
$zips = Get-ChildItem (Join-Path $root '.output') -Filter '*.zip' |
  Where-Object { $_.Name -like "*$new*" } |
  ForEach-Object { $_.FullName }
# Non-fatal: the tag is pushed either way, so a gh hiccup shouldn't fail the release.
& gh @(@('release', 'create', $tag, '--verify-tag', '--title', "Note by Note $new") + $notesArgs + $zips)
if ($LASTEXITCODE -ne 0) {
  Write-Host "    gh release create failed - create it manually: gh release create $tag --generate-notes .output\*$new*.zip" -ForegroundColor Yellow
}

Step "Released $tag"
$zips | ForEach-Object { Write-Host "    $_" -ForegroundColor Green }
Write-Host "`n    Upload the Chrome zip to the Web Store, the Firefox + sources zips to AMO." -ForegroundColor DarkGray

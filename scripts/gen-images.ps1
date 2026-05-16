<#
  gen-images.ps1 — generate / refresh product imagery via KIE.ai

  Usage (from repo root):
    pwsh scripts/gen-images.ps1                        # generate any missing slugs
    pwsh scripts/gen-images.ps1 -Force                 # regenerate everything in the manifest
    pwsh scripts/gen-images.ps1 -Only hero-watch,brand-rigor  # regenerate specific slugs

  Reads:   image-manifest.json   (slug → model + prompt + aspect_ratio)
           .env                  (KIE_AI_API_KEY=...)
  Writes:  <output_dir>/<slug>.png   (default: gadget_assets/)

  Switching models per image: add a "model" field to a manifest entry to override the default
  (e.g. "model": "nano-banana-2" or "flux-2-pro-text-to-image"). See https://kie.ai/market.
#>

param(
  [string]$ManifestPath = "image-manifest.json",
  [string]$EnvPath = ".env",
  [switch]$Force,
  [string[]]$Only,
  [int]$PollIntervalSeconds = 4,
  [int]$MaxAttempts = 120
)

$ErrorActionPreference = "Stop"

# --- Read API key from .env ------------------------------------------------
if (-not (Test-Path $EnvPath)) {
  throw "Env file not found at $EnvPath. Create one with: KIE_AI_API_KEY=your-key"
}
$envContent = Get-Content $EnvPath -Raw
$keyLine = ($envContent -split "`n" | Where-Object { $_ -match "^\s*KIE_AI_API_KEY\s*=" })
if (-not $keyLine) { throw "KIE_AI_API_KEY not found in $EnvPath" }
$key = ($keyLine -replace "^\s*KIE_AI_API_KEY\s*=\s*", "").Trim()
if (-not $key) { throw "KIE_AI_API_KEY is empty in $EnvPath" }

$createHeaders = @{ "Authorization" = "Bearer $key"; "Content-Type" = "application/json; charset=utf-8" }
$pollHeaders   = @{ "Authorization" = "Bearer $key" }

# --- Read manifest --------------------------------------------------------
# UTF-8 explicit: Windows PowerShell 5.1 defaults Get-Content to the system codepage,
# which mangles em-dashes etc. and produces "syntax error" responses from the API.
if (-not (Test-Path $ManifestPath)) { throw "Manifest not found at $ManifestPath" }
$manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$defaults = $manifest.defaults
if (-not $defaults) { throw "Manifest missing 'defaults' block" }
$outDir = if ($manifest.output_dir) { $manifest.output_dir } else { "gadget_assets" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# --- Decide which slugs to run -------------------------------------------
$jobs = @()
foreach ($img in $manifest.images) {
  $slug = $img.slug
  if (-not $slug) { Write-Warning "Manifest entry has no slug; skipping"; continue }

  # If -Only is set, restrict to that list
  if ($Only -and ($Only -notcontains $slug)) { continue }

  $outPath = Join-Path $outDir "$slug.png"

  # Skip if file exists and not forced/explicitly targeted
  if ((Test-Path $outPath) -and -not $Force -and -not $Only) {
    Write-Output "SKIP [$slug] -> $outPath already exists (use -Force to regenerate)"
    continue
  }

  $model         = if ($img.model)         { $img.model }         else { $defaults.model }
  $resolution    = if ($img.resolution)    { $img.resolution }    else { $defaults.resolution }
  $output_format = if ($img.output_format) { $img.output_format } else { $defaults.output_format }
  $aspect        = if ($img.aspect_ratio)  { $img.aspect_ratio }  else { "1:1" }
  $prompt        = $img.prompt
  if ($manifest.style_anchor) { $prompt = "$prompt $($manifest.style_anchor)" }

  $jobs += [pscustomobject]@{
    slug = $slug; outPath = $outPath
    model = $model; aspect = $aspect; resolution = $resolution; format = $output_format
    prompt = $prompt
    taskId = ""; done = $false; status = "pending"
  }
}

if ($jobs.Count -eq 0) {
  Write-Output "Nothing to do. (All manifest images exist; pass -Force or -Only <slug> to regenerate.)"
  exit 0
}

# --- Submit ---------------------------------------------------------------
Write-Output "=== Submitting $($jobs.Count) image task(s) ==="
foreach ($j in $jobs) {
  $body = @{
    model = $j.model
    input = @{
      prompt        = $j.prompt
      aspect_ratio  = $j.aspect
      resolution    = $j.resolution
      output_format = $j.format
    }
  } | ConvertTo-Json -Depth 6

  try {
    # Send as UTF-8 bytes so non-ASCII chars (em-dash, Ø, etc.) survive the wire.
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $resp = Invoke-RestMethod -Uri "https://api.kie.ai/api/v1/jobs/createTask" -Method Post -Headers $createHeaders -Body $bodyBytes
    if ($resp.code -ne 200) { throw "API code $($resp.code): $($resp.msg)" }
    $j.taskId = $resp.data.taskId
    Write-Output "[$($j.slug)] submit OK · model=$($j.model) · task=$($j.taskId)"
  } catch {
    Write-Output "[$($j.slug)] submit FAILED: $_"
    $j.done = $true; $j.status = "submit-failed"
  }
}

# --- Poll + download ------------------------------------------------------
Write-Output ""
Write-Output "=== Polling (interval $PollIntervalSeconds s, max $MaxAttempts attempts) ==="
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  $remaining = ($jobs | Where-Object { -not $_.done }).Count
  if ($remaining -eq 0) { break }

  foreach ($j in $jobs) {
    if ($j.done) { continue }
    try {
      $r = Invoke-RestMethod -Uri "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=$($j.taskId)" -Method Get -Headers $pollHeaders
      $state = $r.data.state
      if ($state -eq "success") {
        $rj = $r.data.resultJson
        if ($rj -is [string]) { $rj = $rj | ConvertFrom-Json }
        $url = $rj.resultUrls[0]
        if (-not $url) { throw "success but no resultUrls" }
        Invoke-WebRequest -Uri $url -OutFile $j.outPath
        $j.done = $true; $j.status = "success"
        Write-Output "[$($j.slug)] done -> $($j.outPath)"
      } elseif ($state -eq "fail") {
        Write-Output "[$($j.slug)] FAILED: $($r.data.failMsg)"
        $j.done = $true; $j.status = "failed"
      }
    } catch {
      Write-Output "[$($j.slug)] poll error: $_"
    }
  }

  $stillRemaining = ($jobs | Where-Object { -not $_.done }).Count
  if ($stillRemaining -gt 0) { Start-Sleep -Seconds $PollIntervalSeconds }
}

# --- Report ----------------------------------------------------------------
Write-Output ""
Write-Output "=== Final ==="
$jobs | Format-Table slug, status, model, taskId -AutoSize

$failed = ($jobs | Where-Object { $_.status -ne "success" }).Count
if ($failed -gt 0) {
  Write-Output ""
  Write-Output "$failed task(s) did not complete. Re-run with -Only <slug1,slug2> to retry specific ones."
  exit 1
}

<#
  gen-video.ps1 — generate a single mood video via KIE.ai

  Usage (from repo root):
    pwsh scripts/gen-video.ps1                          # use defaults (Kling 3.0, 10s, 16:9, pro)
    pwsh scripts/gen-video.ps1 -DryRun                  # print request body + exit, no API call
    pwsh scripts/gen-video.ps1 -Output hero-loop.mp4    # override output filename
    pwsh scripts/gen-video.ps1 -Model veo3_fast -Duration 8

  Reads:   .env  (KIE_AI_API_KEY=...)        — same variable name as gen-images.ps1
  Writes:  <Output>   (default: tester-2030.mp4 in repo root)

  Single-shot: one prompt → one MP4. No manifest. For batch jobs, mirror gen-images.ps1.
#>

param(
  [string]$EnvPath = ".env",
  [string]$Model = "kling-3.0/video",
  [string]$Duration = "10",
  [string]$AspectRatio = "16:9",
  [string]$Mode = "pro",
  [string]$Output = "tester-2030.mp4",
  [string]$Prompt = @"
Cinematic abstract mood film. Pitch-black inky studio with warm amber-gold light slowly drifting across polished titanium and brushed sapphire surfaces in extreme macro close-up. Gentle particle drift, soft volumetric mist illuminated by a single warm rim light. Shallow depth of field, glints of gold catching off brushed metal grain. Slow, meditative, almost imperceptible camera dolly forward. Premium, restrained, prestige feel — like the title sequence of a high-end mechanical watch commercial. No people, no products, no text. Deep ink-black background with warm amber-gold highlights only. Ends on the same composition it begins for seamless loop.
"@,
  [int]$PollIntervalSeconds = 5,
  [int]$MaxAttempts = 240,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# --- Read API key from .env (same variable as gen-images.ps1) ----------------
if (-not (Test-Path $EnvPath)) {
  throw "Env file not found at $EnvPath. Create one with: KIE_AI_API_KEY=your-key"
}
$envContent = Get-Content $EnvPath -Raw -Encoding UTF8
$keyLine = ($envContent -split "`n" | Where-Object { $_ -match "^\s*KIE_AI_API_KEY\s*=" })
if (-not $keyLine) { throw "KIE_AI_API_KEY not found in $EnvPath" }
$key = ($keyLine -replace "^\s*KIE_AI_API_KEY\s*=\s*", "").Trim()
if (-not $key) { throw "KIE_AI_API_KEY is empty in $EnvPath" }

$createHeaders = @{ "Authorization" = "Bearer $key"; "Content-Type" = "application/json; charset=utf-8" }
$pollHeaders   = @{ "Authorization" = "Bearer $key" }

# --- Build request body ------------------------------------------------------
$promptTrimmed = $Prompt.Trim()
$body = @{
  model = $Model
  input = @{
    prompt        = $promptTrimmed
    duration      = $Duration
    aspect_ratio  = $AspectRatio
    mode          = $Mode
    multi_shots   = $false
    sound         = $false
  }
} | ConvertTo-Json -Depth 6

Write-Output "=== Request ==="
Write-Output "  model      : $Model"
Write-Output "  duration   : $Duration sec"
Write-Output "  aspect     : $AspectRatio"
Write-Output "  mode       : $Mode"
Write-Output "  output     : $Output"
Write-Output "  prompt     : $($promptTrimmed.Substring(0, [Math]::Min(140, $promptTrimmed.Length)))..."
Write-Output ""

if ($DryRun) {
  Write-Output "--- DryRun: full request body ---"
  Write-Output $body
  Write-Output ""
  Write-Output "DryRun complete; no API call made."
  exit 0
}

# --- Submit ------------------------------------------------------------------
Write-Output "=== Submitting task ==="
try {
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $resp = Invoke-RestMethod -Uri "https://api.kie.ai/api/v1/jobs/createTask" -Method Post -Headers $createHeaders -Body $bodyBytes
  if ($resp.code -ne 200) { throw "API code $($resp.code): $($resp.msg)" }
  $taskId = $resp.data.taskId
  Write-Output "Submitted OK · taskId=$taskId"
} catch {
  Write-Output "Submit FAILED: $_"
  exit 1
}

# --- Poll --------------------------------------------------------------------
Write-Output ""
Write-Output "=== Polling (interval $PollIntervalSeconds s, max $MaxAttempts attempts) ==="
$resultUrl = $null
$status = "pending"
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  try {
    $r = Invoke-RestMethod -Uri "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=$taskId" -Method Get -Headers $pollHeaders
    $state = $r.data.state
    if ($state -eq "success") {
      $rj = $r.data.resultJson
      if ($rj -is [string]) { $rj = $rj | ConvertFrom-Json }
      $resultUrl = $rj.resultUrls[0]
      if (-not $resultUrl) { throw "success but no resultUrls" }
      $status = "success"
      break
    } elseif ($state -eq "fail") {
      $status = "failed"
      Write-Output "FAILED: $($r.data.failMsg)"
      exit 1
    } else {
      Write-Output "  [attempt $attempt] state=$state"
    }
  } catch {
    Write-Output "  [attempt $attempt] poll error: $_"
  }
  Start-Sleep -Seconds $PollIntervalSeconds
}

if ($status -ne "success") {
  Write-Output "Timed out waiting for video. taskId=$taskId — re-run with same id or check kie.ai dashboard."
  exit 1
}

# --- Download ----------------------------------------------------------------
Write-Output ""
Write-Output "=== Downloading ==="
Write-Output "URL : $resultUrl"
Write-Output "To  : $Output"
Invoke-WebRequest -Uri $resultUrl -OutFile $Output
$bytes = (Get-Item $Output).Length
Write-Output ("Done · {0:N1} MB written" -f ($bytes/1MB))

# --- Report cost if API surfaced it -----------------------------------------
if ($r.data.costPoints -or $r.data.cost) {
  Write-Output ""
  Write-Output "=== Cost ==="
  $r.data | Select-Object cost, costPoints, credits, points | Format-List
}

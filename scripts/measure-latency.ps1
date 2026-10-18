param(
  [int]$Port = 55803,
  [ValidateSet('persistent', 'cold')]
  [string]$Mode = 'persistent',
  [int]$Count = 5
)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$rows = @()
for ($i = 1; $i -le $Count; $i++) {
  $payload = [System.Text.Encoding]::UTF8.GetBytes((@{ mode = $Mode; title = 'latency probe'; body = 'segment timing' } | ConvertTo-Json -Compress))
  $response = Invoke-RestMethod -Uri "$base/task-notify/measure" -Method Post -ContentType 'application/json; charset=utf-8' -Body $payload -TimeoutSec 20
  if (-not $response.ok) { throw "measure failed: $($response | ConvertTo-Json -Compress)" }
  $s = $response.segments
  $row = [ordered]@{ Run = $i }
  if ($Mode -eq 'persistent') {
    $row.triggerToCmd = $s.triggerToCmd
    $row.cmdToRecv = $s.cmdToRecv
    $row.recvToShow = $s.recvToShow
    $row.showToPaint = $s.showToPaint
    $row.paintToHost = $s.paintToHost
  } else {
    $row.triggerToSpawn = $s.triggerToSpawn
    $row.spawnToBoot = $s.spawnToBoot
    $row.bootToTypes = $s.bootToTypes
    $row.typesToForm = $s.typesToForm
    $row.formToShown = $s.formToShown
    $row.shownToPaint = $s.shownToPaint
  }
  $row.total = $s.total
  $rows += [pscustomobject]$row
  Start-Sleep -Milliseconds 300
}

Write-Output "Mode: $Mode  Port: $Port  Count: $Count"
$rows | Format-Table -AutoSize | Out-String -Width 200

$totals = @($rows | ForEach-Object { [int]$_.total } | Sort-Object)
$median = if ($totals.Count -eq 0) { 0 } elseif ($totals.Count % 2 -eq 1) { $totals[[int](($totals.Count - 1) / 2)] } else { [int](($totals[$totals.Count / 2 - 1] + $totals[$totals.Count / 2]) / 2) }
$avg = if ($totals.Count -eq 0) { 0 } else { [int](($totals | Measure-Object -Average).Average) }
Write-Output ("min={0}ms  median={1}ms  avg={2}ms  max={3}ms" -f $totals[0], $median, $avg, $totals[-1])
if ($Mode -eq 'persistent') {
  if ($totals[-1] -le 300) { Write-Output 'PASS: end-to-end <= 300ms' } else { Write-Output 'WARN: end-to-end > 300ms' }
}

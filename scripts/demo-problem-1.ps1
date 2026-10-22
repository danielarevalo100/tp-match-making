# Demo del problema 1: entrar a una cola de matchmaking.
#
# Necesita el stack de Compose corriendo (mongodb, redis y gaming-app). Registra un jugador
# descartable y recorre todas las reglas: éxito, reintento idempotente, segunda cola, partida
# activa, sanción en vigor y una ráfaga concurrente. Limpia lo que crea al terminar.
#
#   .\scripts\demo-problem-1.ps1
#
# Se puede cambiar (variables de entorno): PLAYERS_URL, MATCHMAKING_URL, MODE,
# MONGO_ROOT_USERNAME, MONGO_ROOT_PASSWORD

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Get-Setting($name, $default) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $value } else { $default }
}

$PlayersUrl = Get-Setting "PLAYERS_URL" "http://localhost:3001"
$MatchmakingUrl = Get-Setting "MATCHMAKING_URL" "http://localhost:3001"
$Mode = Get-Setting "MODE" "ranked_1v1"
$MongoUser = Get-Setting "MONGO_ROOT_USERNAME" "gaming_admin"
$MongoPassword = Get-Setting "MONGO_ROOT_PASSWORD" "change_me_local_only"

$script:Failures = 0

function Invoke-Api($method, $url, $body = $null) {
  $arguments = @{ Uri = $url; Method = $method; UseBasicParsing = $true }
  if ($null -ne $body) {
    $arguments.Body = $body
    $arguments.ContentType = "application/json"
  }
  try {
    $response = Invoke-WebRequest @arguments
    $status = [int]$response.StatusCode
    $text = $response.Content
  } catch {
    if ($null -eq $_.Exception.Response) { throw }
    $status = [int]$_.Exception.Response.StatusCode
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    $text = $reader.ReadToEnd()
  }
  [pscustomobject]@{ Status = $status; Text = $text }
}

function Show-Result($result, $expected, $description) {
  if ($result.Text) { Write-Host $result.Text }
  if ($result.Status -eq $expected) {
    Write-Host "  OK   $description (HTTP $($result.Status))"
  } else {
    Write-Host "  FAIL ${description}: expected HTTP $expected, got $($result.Status)"
    $script:Failures++
  }
  Write-Host ""
}

function Invoke-Redis { docker compose exec -T redis redis-cli @args }
function Invoke-Mongo($script) {
  docker compose exec -T mongodb mongosh --quiet -u $MongoUser -p $MongoPassword --authenticationDatabase admin gaming --eval $script
}

$suffix = "{0}{1}" -f [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), (Get-Random -Maximum 99999)
$playerId = $null

try {
  Write-Host "== 1. Register a throwaway player (gaming-app)"
  $registration = @{
    username = "demo_$suffix"; email = "demo_$suffix@example.com"
    password = "a-secure-password"; country = "AR"
  } | ConvertTo-Json -Compress
  $result = Invoke-Api POST "$PlayersUrl/players" $registration
  Show-Result $result 201 "player registered"
  $playerId = ($result.Text | ConvertFrom-Json).id
  Write-Host "playerId = $playerId`n"

  $queueUrl = "$MatchmakingUrl/matchmaking/queue"
  $ticketId = [guid]::NewGuid().ToString()
  $join = @{ playerId = $playerId; mode = $Mode; ticketId = $ticketId } | ConvertTo-Json -Compress
  $joinNew = @{ playerId = $playerId; mode = $Mode } | ConvertTo-Json -Compress

  Write-Host "== 2. Join the queue"
  Show-Result (Invoke-Api POST $queueUrl $join) 201 "joined $Mode"

  Write-Host "== 3. Retry with the same ticketId (idempotent, no duplicate)"
  Show-Result (Invoke-Api POST $queueUrl $join) 200 "replay returns the existing ticket"

  Write-Host "== 4. Join again with another ticketId (one queue at a time)"
  Show-Result (Invoke-Api POST $queueUrl $joinNew) 409 "second queue rejected"

  Write-Host "== 5. Redis state"
  $region = ((Invoke-Api GET "$queueUrl/$playerId").Text | ConvertFrom-Json).region
  Write-Host "-- HGETALL mm:ticket:$playerId"; Invoke-Redis HGETALL "mm:ticket:$playerId"
  Write-Host "-- ZRANGE mm:q:${Mode}:${region}:rating"; Invoke-Redis ZRANGE "mm:q:${Mode}:${region}:rating" 0 -1 WITHSCORES
  Write-Host "-- ZRANGE mm:q:${Mode}:${region}:wait"; Invoke-Redis ZRANGE "mm:q:${Mode}:${region}:wait" 0 -1 WITHSCORES
  Write-Host ""

  Write-Host "== 6. Leave the queue"
  Show-Result (Invoke-Api DELETE "$queueUrl/$playerId") 204 "left the queue"

  Write-Host "== 7. Active match blocks joining (player:<id>:active_match set by hand; problem 2 will set it)"
  Invoke-Redis SET "player:${playerId}:active_match" demo-match | Out-Null
  Show-Result (Invoke-Api POST $queueUrl $joinNew) 409 "player with an active match rejected"
  Invoke-Redis DEL "player:${playerId}:active_match" | Out-Null

  Write-Host "== 8. Sanction in force blocks joining (inserted directly in MongoDB; problem 8 will create them)"
  Invoke-Mongo "db.sanctions.insertOne({ _id: crypto.randomUUID(), playerId: '$playerId', adminId: crypto.randomUUID(), type: 'temporary_suspension', reason: 'demo', startsAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 3600000), status: 'active', createdAt: new Date() })" | Out-Null
  Show-Result (Invoke-Api POST $queueUrl $joinNew) 403 "sanctioned player rejected"
  Invoke-Mongo "db.sanctions.deleteMany({ playerId: '$playerId' })" | Out-Null

  Write-Host "== 9. 20 concurrent requests for the same player: exactly one must win"
  $jobs = 1..20 | ForEach-Object {
    Start-Job -ArgumentList $queueUrl, $joinNew -ScriptBlock {
      param($url, $body)
      try {
        [int](Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType "application/json" -UseBasicParsing).StatusCode
      } catch { [int]$_.Exception.Response.StatusCode }
    }
  }
  $codes = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job
  $codes | Group-Object | ForEach-Object { Write-Host ("  {0,3} x HTTP {1}" -f $_.Count, $_.Name) }
  $inQueue = @(Invoke-Redis ZSCORE "mm:q:${Mode}:${region}:rating" $playerId | Where-Object { $_ }).Count
  Write-Host "  entries for the player in the rating ZSET: $inQueue (expected 1)"
  if ($inQueue -ne 1) { $script:Failures++ }
  Write-Host ""
} finally {
  if ($playerId) {
    try { Invoke-Api DELETE "$MatchmakingUrl/matchmaking/queue/$playerId" | Out-Null } catch { }
    try { Invoke-Redis DEL "player:${playerId}:active_match" | Out-Null } catch { }
    try { Invoke-Mongo "db.sanctions.deleteMany({ playerId: '$playerId' })" | Out-Null } catch { }
  }
}

if ($script:Failures -eq 0) {
  Write-Host "Problem 1 demo: all checks passed"
} else {
  Write-Host "Problem 1 demo: $($script:Failures) check(s) failed"
  exit 1
}

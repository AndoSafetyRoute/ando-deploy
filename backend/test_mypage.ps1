# test_mypage.ps1
$BASE = "http://localhost:5000"

Write-Host "[1] Getting Firebase token..." -ForegroundColor Cyan
$token = .\get_token.ps1
if (-not $token) { Write-Host "FAIL: token" -ForegroundColor Red; exit 1 }
Write-Host "OK: $($token.Substring(0,20))..." -ForegroundColor Green
$h = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

Write-Host "[2] POST /auth/login" -ForegroundColor Cyan
$user = Invoke-RestMethod -Method POST -Uri "$BASE/auth/login" -Headers @{"Content-Type"="application/json"} -Body (ConvertTo-Json @{ id_token = $token })
Write-Host "OK: uid=$($user.uid) type=$($user.user_type)" -ForegroundColor Green

Write-Host "[3] POST /user/routes" -ForegroundColor Cyan
$body = '{"from_name":"Seoul Station","to_name":"Namsan Tower","mode":"walk","walker_type":"manual_wheelchair","total_duration_ms":720000,"date":"2026-05-20T12:00:00+09:00","segments":[{"index":0,"distanceM":5.0,"slopePercent":1.2,"elapsedMs":8000},{"index":1,"distanceM":5.0,"slopePercent":3.5,"elapsedMs":12000},{"index":2,"distanceM":5.0,"slopePercent":0.8,"elapsedMs":7000}]}'
try {
    $r = Invoke-RestMethod -Method POST -Uri "$BASE/user/routes" -Headers $h -Body $body
    $rid = $r.route_id
    Write-Host "OK: route_id=$rid" -ForegroundColor Green
} catch {
    Write-Host "FAIL: $_" -ForegroundColor Red; exit 1
}

Write-Host "[4] GET /user/routes" -ForegroundColor Cyan
try {
    $routes = Invoke-RestMethod -Method GET -Uri "$BASE/user/routes" -Headers $h
    Write-Host "OK: $($routes.Count) routes, segments=$($routes[0].segments.Count), satisfaction=$($routes[0].satisfaction)" -ForegroundColor Green
} catch {
    Write-Host "FAIL: $_" -ForegroundColor Red
}

Write-Host "[5] POST /routes/$rid/feedback (rating=4)" -ForegroundColor Cyan
try {
    $fb = Invoke-RestMethod -Method POST -Uri "$BASE/routes/$rid/feedback" -Headers $h -Body (ConvertTo-Json @{ rating = 4 })
    Write-Host "OK: rating=$($fb.rating)" -ForegroundColor Green
} catch {
    Write-Host "FAIL: $_" -ForegroundColor Red
}

Write-Host "[6] POST /routes/$rid/feedback (rating=5, upsert)" -ForegroundColor Cyan
try {
    $fb2 = Invoke-RestMethod -Method POST -Uri "$BASE/routes/$rid/feedback" -Headers $h -Body (ConvertTo-Json @{ rating = 5 })
    Write-Host "OK: rating=$($fb2.rating)" -ForegroundColor Green
} catch {
    Write-Host "FAIL: $_" -ForegroundColor Red
}

Write-Host "[7] GET /user/routes (satisfaction check)" -ForegroundColor Cyan
try {
    $routes2 = Invoke-RestMethod -Method GET -Uri "$BASE/user/routes" -Headers $h
    $match = $routes2 | Where-Object { $_.id -eq $rid }
    Write-Host "OK: satisfaction=$($match.satisfaction)" -ForegroundColor Green
} catch {
    Write-Host "FAIL: $_" -ForegroundColor Red
}

Write-Host "=== DONE ===" -ForegroundColor Cyan

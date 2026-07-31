$token = .\get_token.ps1
Write-Host "토큰 취득 완료"

$body = ConvertTo-Json @{ id_token = $token }
$res  = Invoke-RestMethod -Method POST -Uri "http://localhost:5000/auth/login" -ContentType "application/json" -Body $body
Write-Host "응답:"
$res | ConvertTo-Json

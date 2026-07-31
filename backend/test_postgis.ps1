$body = ConvertTo-Json @{
    origin_lon = 126.9947
    origin_lat = 37.5347
    dest_lon   = 126.9985
    dest_lat   = 37.5512
    user_type  = "elderly"
    algorithm  = "auto"
    mode       = "accessibility"
}

$res = Invoke-RestMethod -Method POST -Uri "http://localhost:5000/route" -ContentType "application/json" -Body $body

Write-Host "algorithm      : $($res.algorithm)"
Write-Host "total_length_m : $($res.total_length_m)"
Write-Host "avg_slope_pct  : $($res.avg_slope_pct)"
Write-Host "segments       : $($res.segments.Count)"
Write-Host "route_id       : $($res.route_id)"

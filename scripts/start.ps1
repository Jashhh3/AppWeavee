$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'bootstrap-env.ps1')
docker compose up --build -d
docker compose ps
Write-Host 'Dashboard: http://localhost:8080'
Write-Host 'API health: http://localhost:3000/health'

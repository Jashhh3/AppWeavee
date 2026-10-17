param([switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
function New-Secret { param([int]$Bytes = 32); $bytes = New-Object byte[] $Bytes; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes); return ([Convert]::ToHexString($bytes)).ToLowerInvariant() }
$values = @{}
if (Test-Path $envPath) { Get-Content $envPath | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { $values[$matches[1]] = $matches[2] } } }
if ($Force -or [string]::IsNullOrWhiteSpace($values['JWT_SECRET']) -or $values['JWT_SECRET'] -match 'replace-with|change-me') { $values['JWT_SECRET'] = New-Secret }
if ($Force -or [string]::IsNullOrWhiteSpace($values['AI_ENCRYPTION_KEY']) -or $values['AI_ENCRYPTION_KEY'] -match 'replace-with|change-me') { $values['AI_ENCRYPTION_KEY'] = New-Secret }
if ([string]::IsNullOrWhiteSpace($values['ALLOWED_ORIGINS'])) { $values['ALLOWED_ORIGINS'] = 'http://localhost:8080,http://127.0.0.1:8080' }
if ([string]::IsNullOrWhiteSpace($values['VITE_API_URL'])) { $values['VITE_API_URL'] = 'http://localhost:3000' }
@("JWT_SECRET=$($values['JWT_SECRET'])", "AI_ENCRYPTION_KEY=$($values['AI_ENCRYPTION_KEY'])", "ALLOWED_ORIGINS=$($values['ALLOWED_ORIGINS'])", "VITE_API_URL=$($values['VITE_API_URL'])") | Set-Content -Path $envPath -Encoding utf8
Write-Host "AppWeave environment is ready: $envPath"
Write-Host "Secrets were generated only when missing; existing secrets were preserved."

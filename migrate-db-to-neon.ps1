# Перенос БД walknorth: Render (или локальная) -> Neon
# Использование:
#   $env:SOURCE_DATABASE_URL = "postgresql://...@...render.com/walknorth?sslmode=require"
#   $env:TARGET_DATABASE_URL = "postgresql://...@...neon.tech/neondb?sslmode=require"
#   .\migrate-db-to-neon.ps1

$pgDump = "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
$psql = "C:\Program Files\PostgreSQL\17\bin\psql.exe"
$dumpFile = "$env:USERPROFILE\Desktop\walknorth_neon_dump.sql"

if (-not $env:SOURCE_DATABASE_URL) {
    Write-Host "Задайте SOURCE_DATABASE_URL (старая БД Render или локальная)"
    exit 1
}
if (-not $env:TARGET_DATABASE_URL) {
    Write-Host "Задайте TARGET_DATABASE_URL (Neon connection string)"
    exit 1
}

Write-Host "1. В Neon SQL Editor выполните: CREATE EXTENSION IF NOT EXISTS postgis;"
Write-Host "2. Экспорт из источника..."
& $pgDump $env:SOURCE_DATABASE_URL --no-owner --no-acl -f $dumpFile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "3. Импорт в Neon..."
& $psql $env:TARGET_DATABASE_URL -v ON_ERROR_STOP=1 -f $dumpFile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Готово. Файл дампа: $dumpFile"

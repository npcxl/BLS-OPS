# 可重复的数据库基准入口：需要本地 MySQL 8.0（默认 127.0.0.1:3306）。
# 只运行已有的真实 MySQL 集成基准，不模拟、不造数据。
param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3306,
  [string]$User = "root",
  [string]$Password = "bls_test_pw"
)

$ErrorActionPreference = "Stop"
$env:BLS_TEST_MYSQL_HOST = $HostName
$env:BLS_TEST_MYSQL_PORT = "$Port"
$env:BLS_TEST_MYSQL_USER = $User
$env:BLS_TEST_MYSQL_PASSWORD = $Password
$env:BLS_TEST_MYSQL_REQUIRED = "1"

if (-not (Test-NetConnection $HostName -Port $Port -InformationLevel Quiet)) {
  throw "MySQL $HostName`:$Port 不可达；先启动 MySQL 或 Docker 容器"
}

Push-Location (Join-Path $PSScriptRoot "..\src-tauri")
try {
  cargo test --test database_mysql mysql_million_rows_keyset_stays_bounded -- --test-threads=1 --nocapture
  cargo test --test database_mysql mysql_types_multi_result_and_cancel -- --test-threads=1 --nocapture
  cargo test --test database_mysql mysql_schema_operations_are_real -- --test-threads=1 --nocapture
} finally {
  Pop-Location
}

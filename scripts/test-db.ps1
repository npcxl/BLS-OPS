# 数据库集成测试入口：一条命令复现 CI 的 database job。
#
# 覆盖范围与 CI 一致：
#   * MySQL 协议家族（mysql / mariadb 二选一）→ tests/database_mysql.rs
#   * PostgreSQL                            → tests/database_postgres.rs
# Redis 不在里面：Windows 上没有稳定的 Redis 服务端；需要时用 docker 起一个并
# 单独跑 `cargo test --test database_redis`。
#
# 本机默认端口对齐 docker 测试容器：
#   bls-mysql-test 127.0.0.1:33306 / mariadb-test 127.0.0.1:33070 / bls-pg-test 127.0.0.1:55432
param(
  [ValidateSet("mysql", "mariadb")]
  [string]$Distribution = "mysql",
  # 0 = 用该发行版本机容器的默认端口
  [int]$Port = 0,
  [string]$MySqlUser = "root",
  [string]$MySqlPassword = "bls_test_pw",
  [string]$PgHost = "127.0.0.1",
  [int]$PgPort = 55432,
  [string]$PgUser = "postgres",
  [string]$PgPassword = "bls_test_pw",
  [string]$PgDatabase = "ops_test"
)

$ErrorActionPreference = "Stop"

if ($Port -eq 0) {
  $Port = if ($Distribution -eq "mariadb") { 33070 } else { 33306 }
}

function Assert-Reachable([string]$Name, [string]$Target, [int]$TargetPort) {
  if (-not (Test-NetConnection $Target -Port $TargetPort -InformationLevel Quiet)) {
    throw "$Name $Target`:$TargetPort 不可达；先启动容器（如 docker start bls-mysql-test mariadb-test bls-pg-test）"
  }
}

Assert-Reachable "MySQL 协议端" "127.0.0.1" $Port
Assert-Reachable "PostgreSQL" $PgHost $PgPort

# 与 .github/workflows/ci.yml 的 database job 用同一组变量名：
# 集成测试读不到实例时必须红，不能被 skip 吞掉。
$env:BLS_TEST_MYSQL_HOST = "127.0.0.1"
$env:BLS_TEST_MYSQL_PORT = "$Port"
$env:BLS_TEST_MYSQL_USER = $MySqlUser
$env:BLS_TEST_MYSQL_PASSWORD = $MySqlPassword
$env:BLS_TEST_MYSQL_REQUIRED = "1"

$env:BLS_TEST_PG_HOST = $PgHost
$env:BLS_TEST_PG_PORT = "$PgPort"
$env:BLS_TEST_PG_USER = $PgUser
$env:BLS_TEST_PG_PASSWORD = $PgPassword
$env:BLS_TEST_PG_DB = $PgDatabase
$env:BLS_TEST_PG_REQUIRED = "1"

Write-Host "[db] $Distribution @ 127.0.0.1:$Port + PostgreSQL @ ${PgHost}:$PgPort" -ForegroundColor Cyan

Push-Location (Join-Path $PSScriptRoot "..\src-tauri")
try {
  # 两个套件共用 ops_test，必须串行：并行会互相 DROP TABLE。
  cargo test --test database_mysql --test database_postgres -- --test-threads=1
  if ($LASTEXITCODE -ne 0) { throw "数据库集成测试失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}

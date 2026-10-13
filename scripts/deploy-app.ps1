# 에스크로 앱 배포 (main 커밋 → gh-pages 복사·커밋·푸시 → 라이브 반영 확인)
# 사용: powershell -File scripts\deploy-app.ps1 -Message "v21: 설명"
# 세 곳(앱 본문 APP_VERSION / frontend\version.json / 배포 루트 version.json)의 버전이 다르면 배포하지 않고 멈춘다.
param([Parameter(Mandatory = $true)][string]$Message)
Set-Location C:\Projects\mpc-escrow
$attr = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'

function G { & git @args; if ($LASTEXITCODE -ne 0) { throw "git 실패: git $($args -join ' ')" } }
function Ver($file, $rx) { [regex]::Match((Get-Content $file -Raw -Encoding UTF8), $rx).Groups[1].Value }

# 1) main 커밋·푸시 (수정된 추적 파일 + 새 스크립트)
$vApp = Ver 'frontend\index.html' "APP_VERSION = '(\d+)'"
$vJson = Ver 'frontend\version.json' '"v":"(\d+)"'
if ($vApp -ne $vJson) { throw "버전 불일치(main): index=$vApp / version.json=$vJson" }
G add -u
if (git status --porcelain | Where-Object { $_ -match '^[AM]' }) {
  G commit -m $Message -m $attr
  G push origin main
} else { Write-Host '[main] 새 변경 없음 — 커밋 생략' }

# 2) gh-pages 로 복사
G checkout gh-pages
try {
  G checkout main -- frontend/index.html frontend/version.json admin.html
  Copy-Item frontend\index.html index.html -Force
  Copy-Item frontend\version.json version.json -Force
  $vRoot = Ver 'version.json' '"v":"(\d+)"'
  $vRootApp = Ver 'index.html' "APP_VERSION = '(\d+)'"
  if ($vRoot -ne $vApp -or $vRootApp -ne $vApp) { throw "버전 불일치(배포): 앱=$vApp / 루트 version.json=$vRoot / 루트 index=$vRootApp" }
  G add index.html version.json admin.html frontend/index.html frontend/version.json
  if (git status --porcelain | Where-Object { $_ -match '^[AM]' }) {
    G commit -m "deploy $vApp" -m $attr
    G push origin gh-pages
  } else { Write-Host '[gh-pages] 새 변경 없음 — 배포 커밋 생략' }
} finally { git checkout main 2>$null | Out-Null }

# 3) 라이브 반영 확인 (version.json 과 본문 둘 다)
$deadline = (Get-Date).AddMinutes(8); $ok = $false
while ((Get-Date) -lt $deadline) {
  $lv = curl.exe -s --compressed "https://mpcescrow.com/mpc-escrow/version.json?cb=$(Get-Random)"
  $li = curl.exe -s --compressed "https://mpcescrow.com/mpc-escrow/?cb=$(Get-Random)"
  if ($lv -match "`"v`":`"$vApp`"" -and $li -match "APP_VERSION = '$vApp'") { $ok = $true; break }
  Start-Sleep -Seconds 25
}
if ($ok) { Write-Host "[완료] 라이브 v$vApp 반영·정합 확인 ($(Get-Date -Format HH:mm:ss))" }
else { throw "라이브가 8분 안에 v$vApp 로 맞춰지지 않음 — 수동 확인 필요" }

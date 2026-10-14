# 약속장부를 GitHub Pages(무료, 공개 저장소)에 올린다. Boss가 직접 실행하는 "마지막 버튼".
# 처음 실행: 저장소를 만들고 올린 뒤 Pages를 켠다. 다음부터: 바뀐 내용만 올린다.
#   실행:  powershell -ExecutionPolicy Bypass -File .\deploy_pages.ps1
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$owner = (gh api user --jq .login).Trim()
$repo = 'promise-ledger'
$url = "https://$($owner.ToLower()).github.io/$repo/"

Write-Host ""
Write-Host "올릴 곳 : github.com/$owner/$repo (공개 저장소)"
Write-Host "앱 주소 : $url"
Write-Host "올라가는 것: 앱 코드뿐입니다. 사용자 기록은 각자 폰에만 있고 올라가지 않습니다."
$answer = Read-Host "올릴까요? (y/n)"
if ($answer -ne 'y') { Write-Host "취소했습니다."; exit 0 }

if (-not (Test-Path .git)) {
  git init -b main | Out-Null
  if (-not (Test-Path .nojekyll)) { New-Item -ItemType File .nojekyll | Out-Null }
}
git add -A
$pending = git status --porcelain
if ($pending) { git commit -m "deploy $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null }

# "repo not found" is an expected answer here, not a failure
$ErrorActionPreference = 'Continue'
gh repo view "$owner/$repo" --json name 2>$null | Out-Null
$exists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'

if (-not $exists) {
  gh repo create "$owner/$repo" --public --source . --remote origin --push --description "Promise ledger: daily close log for field freelancers"
  gh api "repos/$owner/$repo/pages" -X POST -f "source[branch]=main" -f "source[path]=/" | Out-Null
  Write-Host "Pages를 켰습니다. 첫 배포는 1~2분 걸립니다."
} else {
  git push origin main
  Write-Host "바뀐 내용을 올렸습니다. 반영까지 1분 정도 걸립니다."
}

Write-Host ""
Write-Host "앱 주소: $url"
Write-Host "폰에서 이 주소를 열고 '홈 화면에 추가'를 눌러 주세요."

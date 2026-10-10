Add-Type -AssemblyName System.Drawing

$W = 1080; $H = 1400
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'

$navy   = [System.Drawing.ColorTranslator]::FromHtml('#0A0F1E')
$card   = [System.Drawing.ColorTranslator]::FromHtml('#0F1A30')
$gold   = [System.Drawing.ColorTranslator]::FromHtml('#C9A84C')
$white  = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$grey   = [System.Drawing.ColorTranslator]::FromHtml('#B8C6D8')
$green  = [System.Drawing.ColorTranslator]::FromHtml('#2ECC71')

$g.Clear($navy)
$goldBrush  = New-Object System.Drawing.SolidBrush($gold)
$whiteBrush = New-Object System.Drawing.SolidBrush($white)
$greyBrush  = New-Object System.Drawing.SolidBrush($grey)
$greenBrush = New-Object System.Drawing.SolidBrush($green)
$cardBrush  = New-Object System.Drawing.SolidBrush($card)
$goldPen    = New-Object System.Drawing.Pen($gold, 3)
$greenPen   = New-Object System.Drawing.Pen($green, 5)

$fTitle   = New-Object System.Drawing.Font('맑은 고딕', 40, [System.Drawing.FontStyle]::Bold)
$fSub     = New-Object System.Drawing.Font('맑은 고딕', 22, [System.Drawing.FontStyle]::Regular)
$fItem    = New-Object System.Drawing.Font('맑은 고딕', 25, [System.Drawing.FontStyle]::Bold)
$fDesc    = New-Object System.Drawing.Font('맑은 고딕', 19, [System.Drawing.FontStyle]::Regular)
$fSmall   = New-Object System.Drawing.Font('맑은 고딕', 18, [System.Drawing.FontStyle]::Regular)

$center = New-Object System.Drawing.StringFormat
$center.Alignment = 'Center'

# 헤더
$g.DrawString('P2P방 입장 전 체크리스트', $fTitle, $goldBrush, (New-Object System.Drawing.RectangleF(0, 55, $W, 70)), $center)
$g.DrawString('아래 4가지를 모두 마친 후 입장을 신청해주세요', $fSub, $whiteBrush, (New-Object System.Drawing.RectangleF(0, 135, $W, 45)), $center)
$g.DrawLine($goldPen, 340, 200, 740, 200)

function Draw-Item($y, $num, $title, $desc1, $desc2) {
  $g.FillRectangle($cardBrush, 60, $y, 960, 210)
  $g.DrawRectangle($goldPen, 60, $y, 960, 210)
  # 체크박스
  $g.DrawRectangle($greenPen, 95, ($y+70), 70, 70)
  $pts = @( (New-Object System.Drawing.Point(108, ($y+105))), (New-Object System.Drawing.Point(126, ($y+125))), (New-Object System.Drawing.Point(155, ($y+82))) )
  $g.DrawLines($greenPen, $pts)
  # 텍스트
  $g.DrawString("$num  $title", $fItem, $whiteBrush, 200, ($y+38))
  $g.DrawString($desc1, $fDesc, $greyBrush, 202, ($y+100))
  if ($desc2) { $g.DrawString($desc2, $fDesc, $greyBrush, 202, ($y+140)) }
}

Draw-Item 240 '1.' 'Trust Wallet 준비' '앱 설치와 지갑 생성을 마쳤습니다.' ''
Draw-Item 475 '2.' '에스크로 앱 설치 + 연결' '홈 화면에 앱을 설치하고, 지갑 연결까지 해봤습니다.' ''
Draw-Item 710 '3.' '거래 방법 학습' '가이드 문서 또는 영상으로 판매, 구매 절차를' '확인했습니다.'
Draw-Item 945 '4.' '보안 수칙 숙지' '홈 화면 아이콘으로만 접속 / 개인 채팅 링크 금지 /' '서명 시 주소 끝자리 5972 확인'

# 푸터
$g.DrawLine($goldPen, 60, 1215, 1020, 1215)
$g.DrawString('4가지가 모두 준비되면 소속 커뮤니티 대표님께 입장을 신청하세요', $fSmall, $whiteBrush, (New-Object System.Drawing.RectangleF(0, 1245, $W, 40)), $center)
$g.DrawString('공식 주소: bag8516-dev.github.io/mpc-escrow  (철자가 다르면 사기입니다)', $fSmall, $goldBrush, (New-Object System.Drawing.RectangleF(0, 1295, $W, 40)), $center)

$g.Dispose()
$out = 'C:\Users\박세진\OneDrive\Desktop\업무관련\MPC에스크로_입장전체크리스트.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "저장: $out"

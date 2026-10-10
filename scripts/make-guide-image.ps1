Add-Type -AssemblyName System.Drawing

$W = 1080; $H = 1500
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'

# 색상
$navy   = [System.Drawing.ColorTranslator]::FromHtml('#0A0F1E')
$card   = [System.Drawing.ColorTranslator]::FromHtml('#0F1A30')
$border = [System.Drawing.ColorTranslator]::FromHtml('#C9A84C')
$gold   = [System.Drawing.ColorTranslator]::FromHtml('#C9A84C')
$white  = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$grey   = [System.Drawing.ColorTranslator]::FromHtml('#B8C6D8')

$g.Clear($navy)

$goldBrush  = New-Object System.Drawing.SolidBrush($gold)
$whiteBrush = New-Object System.Drawing.SolidBrush($white)
$greyBrush  = New-Object System.Drawing.SolidBrush($grey)
$cardBrush  = New-Object System.Drawing.SolidBrush($card)
$goldPen    = New-Object System.Drawing.Pen($gold, 3)

$fTitle   = New-Object System.Drawing.Font('맑은 고딕', 44, [System.Drawing.FontStyle]::Bold)
$fSection = New-Object System.Drawing.Font('맑은 고딕', 30, [System.Drawing.FontStyle]::Bold)
$fBody    = New-Object System.Drawing.Font('맑은 고딕', 24, [System.Drawing.FontStyle]::Regular)
$fBodyB   = New-Object System.Drawing.Font('맑은 고딕', 24, [System.Drawing.FontStyle]::Bold)
$fSmall   = New-Object System.Drawing.Font('맑은 고딕', 19, [System.Drawing.FontStyle]::Regular)

$center = New-Object System.Drawing.StringFormat
$center.Alignment = 'Center'

# ── 헤더 ──
$g.DrawString('MPC 에스크로', $fTitle, $goldBrush, (New-Object System.Drawing.RectangleF(0, 60, $W, 80)), $center)
$g.DrawString('앱 설치 방법 안내', $fSection, $whiteBrush, (New-Object System.Drawing.RectangleF(0, 145, $W, 60)), $center)
$g.DrawLine($goldPen, 390, 220, 690, 220)

# ── 안드로이드 카드 ──
$y = 270
$g.FillRectangle($cardBrush, 60, $y, $W-120, 330)
$g.DrawRectangle($goldPen, 60, $y, $W-120, 330)
$g.DrawString('안드로이드 (갤럭시)', $fSection, $goldBrush, 100, ($y+30))
$g.DrawString('1.  단톡방의 링크를 눌러 접속합니다', $fBody, $whiteBrush, 100, ($y+105))
$g.DrawString('2.  [ 홈 화면에 앱 설치 ] 버튼을 누릅니다', $fBody, $whiteBrush, 100, ($y+165))
$g.DrawString('3.  설치 확인창에서 [ 설치 ]를 누르면 끝!', $fBody, $whiteBrush, 100, ($y+225))

# ── 아이폰 카드 ──
$y = 650
$g.FillRectangle($cardBrush, 60, $y, $W-120, 450)
$g.DrawRectangle($goldPen, 60, $y, $W-120, 450)
$g.DrawString('아이폰', $fSection, $goldBrush, 100, ($y+30))
$g.DrawString('1.  단톡방의 링크를 눌러 접속합니다', $fBody, $whiteBrush, 100, ($y+105))
$g.DrawString('2.  카카오톡 화면의 메뉴( --- )에서', $fBody, $whiteBrush, 100, ($y+165))
$g.DrawString('     [ Safari로 열기 ]를 누릅니다', $fBodyB, $whiteBrush, 100, ($y+215))
$g.DrawString('3.  사파리 아래의 공유 버튼(네모+화살표)을 누르고', $fBody, $whiteBrush, 100, ($y+280))
$g.DrawString('     [ 홈 화면에 추가 ] - [ 추가 ]를 누르면 끝!', $fBodyB, $whiteBrush, 100, ($y+330))

# ── 완료 안내 ──
$y = 1160
$g.DrawString('홈 화면에 생긴 금색 MPC 아이콘을 누르면', $fBody, $greyBrush, (New-Object System.Drawing.RectangleF(0, $y, $W, 50)), $center)
$g.DrawString('앱처럼 바로 실행됩니다', $fBody, $greyBrush, (New-Object System.Drawing.RectangleF(0, ($y+55), $W, 50)), $center)

# ── 푸터 ──
$g.DrawLine($goldPen, 60, 1330, ($W-60), 1330)
$g.DrawString('설치는 한 번만 하면 됩니다  ·  설치가 안 되면 카카오 문의 주세요', $fSmall, $greyBrush, (New-Object System.Drawing.RectangleF(0, 1360, $W, 50)), $center)
$g.DrawString('공식 주소: bag8516-dev.github.io/mpc-escrow', $fSmall, $goldBrush, (New-Object System.Drawing.RectangleF(0, 1410, $W, 50)), $center)

$g.Dispose()
$out = 'C:\Users\박세진\OneDrive\Desktop\업무관련\MPC에스크로_앱설치안내.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "저장: $out"

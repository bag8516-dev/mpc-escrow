Add-Type -AssemblyName System.Drawing
foreach ($size in 192,512) {
  $bmp = New-Object System.Drawing.Bitmap($size,$size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0A0F1E'))
  $pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#C9A84C'), [Math]::Max(2,$size/48))
  $margin = [int]($size*0.12)
  $g.DrawEllipse($pen, $margin, $margin, $size-2*$margin, $size-2*$margin)
  $font = New-Object System.Drawing.Font('Arial Black', [int]($size*0.20), [System.Drawing.FontStyle]::Bold)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#C9A84C'))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $g.DrawString('MPC', $font, $brush, $rect, $fmt)
  $g.Dispose()
  $out = Join-Path $PSScriptRoot "..\frontend\icon-$size.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "생성: icon-$size.png"
}

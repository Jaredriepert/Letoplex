# Builds the app icons from design/icon-source.png (square PNG, transparent
# background). The source is scaled as a whole, so its framing, including any
# deliberate off-centre placement for optical balance, is kept in every size.
# Windows PowerShell:  npm run icons   (or: .\scripts\make-icons.ps1)
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\design\icon-source.png'),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\public\icons')
)
$Source = (Resolve-Path $Source).Path
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile($Source)

function Write-Icon([string]$name, [int]$size, [double]$fill, [string]$background) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingQuality = 'HighQuality'; $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  if ($background) { $g.Clear([System.Drawing.ColorTranslator]::FromHtml($background)) } else { $g.Clear([System.Drawing.Color]::Transparent) }
  # The whole source square takes up `fill` of the icon, centred as a square.
  $edge = [Math]::Round($size * $fill)
  $offset = [Math]::Round(($size - $edge) / 2)
  $dest = New-Object System.Drawing.Rectangle $offset, $offset, $edge, $edge
  $attrs = New-Object System.Drawing.Imaging.ImageAttributes
  $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)  # no dark fringe at the edges
  $g.DrawImage($src, $dest, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
  $g.Dispose()
  $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "wrote $name"
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
# Transparent icons use the artwork exactly as framed.
Write-Icon 'icon-192.png' 192 1.0 $null
Write-Icon 'icon-512.png' 512 1.0 $null
# Maskable: Android may crop to a circle with a radius of 40%, so shrink the
# square until the outermost rays sit inside that circle.
Write-Icon 'icon-maskable-512.png' 512 0.72 '#efe1cc'
# iOS fills transparency with black and rounds the corners itself.
Write-Icon 'apple-touch-icon.png' 180 0.88 '#efe1cc'
$src.Dispose()

# Slice sprite sheet into individual PNGs by connected components on near-white bg
Add-Type -AssemblyName System.Drawing

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
# cats_run folder
$gameRoot = Split-Path $PSScriptRoot -Parent
$imgDir = Join-Path $gameRoot "图片"
$outDir = Join-Path $gameRoot "assets"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$sheetPath = Join-Path $imgDir "6c9f8d8a4286ee119648e74baad8ef2d.jpg"
$bmp = [System.Drawing.Bitmap]::FromFile($sheetPath)
$w = $bmp.Width
$h = $bmp.Height
Write-Host "Sheet: ${w}x${h}"

function IsBg([System.Drawing.Color]$c) {
  return ($c.R -gt 245 -and $c.G -gt 245 -and $c.B -gt 245)
}

$visited = New-Object 'bool[,]' $w, $h
$boxes = New-Object System.Collections.Generic.List[object]
$minArea = 800

for ($y = 0; $y -lt $h; $y += 2) {
  for ($x = 0; $x -lt $w; $x += 2) {
    if ($visited[$x, $y]) { continue }
    $pix = $bmp.GetPixel($x, $y)
    if (IsBg $pix) { $visited[$x, $y] = $true; continue }

    # flood fill bbox
    $stack = New-Object System.Collections.Generic.Stack[object]
    $stack.Push(@($x, $y))
    $minX = $x; $maxX = $x; $minY = $y; $maxY = $y
    $count = 0
    while ($stack.Count -gt 0) {
      $p = $stack.Pop()
      $cx = $p[0]; $cy = $p[1]
      if ($cx -lt 0 -or $cy -lt 0 -or $cx -ge $w -or $cy -ge $h) { continue }
      if ($visited[$cx, $cy]) { continue }
      $visited[$cx, $cy] = $true
      $cp = $bmp.GetPixel($cx, $cy)
      if (IsBg $cp) { continue }
      $count++
      if ($cx -lt $minX) { $minX = $cx }
      if ($cx -gt $maxX) { $maxX = $cx }
      if ($cy -lt $minY) { $minY = $cy }
      if ($cy -gt $maxY) { $maxY = $cy }
      # 4-neigh step 1 for accuracy on edges, but sample every 1
      $stack.Push(@(($cx + 1), $cy))
      $stack.Push(@(($cx - 1), $cy))
      $stack.Push(@($cx, ($cy + 1)))
      $stack.Push(@($cx, ($cy - 1)))
      if ($count -gt 200000) { break }
    }
    $bw = $maxX - $minX + 1
    $bh = $maxY - $minY + 1
    if ($count -ge $minArea -and $bw -gt 20 -and $bh -gt 20) {
      $boxes.Add([pscustomobject]@{ X = $minX; Y = $minY; W = $bw; H = $bh; Area = $count })
    }
  }
}

# Merge overlapping/nearby boxes
function Overlaps($a, $b, $pad) {
  return -not (($a.X + $a.W + $pad) -lt $b.X -or ($b.X + $b.W + $pad) -lt $a.X -or ($a.Y + $a.H + $pad) -lt $b.Y -or ($b.Y + $b.H + $pad) -lt $a.Y)
}

$merged = New-Object System.Collections.Generic.List[object]
foreach ($b in ($boxes | Sort-Object Area -Descending)) {
  $hit = $false
  for ($i = 0; $i -lt $merged.Count; $i++) {
    if (Overlaps $merged[$i] $b 12) {
      $m = $merged[$i]
      $nx = [Math]::Min($m.X, $b.X)
      $ny = [Math]::Min($m.Y, $b.Y)
      $nx2 = [Math]::Max($m.X + $m.W, $b.X + $b.W)
      $ny2 = [Math]::Max($m.Y + $m.H, $b.Y + $b.H)
      $merged[$i] = [pscustomobject]@{ X = $nx; Y = $ny; W = ($nx2 - $nx); H = ($ny2 - $ny); Area = ($m.Area + $b.Area) }
      $hit = $true
      break
    }
  }
  if (-not $hit) { $merged.Add($b) }
}

# Sort reading order
$sorted = $merged | Sort-Object Y, X
$i = 0
$atlas = @{}
foreach ($b in $sorted) {
  $pad = 4
  $sx = [Math]::Max(0, $b.X - $pad)
  $sy = [Math]::Max(0, $b.Y - $pad)
  $sw = [Math]::Min($w - $sx, $b.W + $pad * 2)
  $sh = [Math]::Min($h - $sy, $b.H + $pad * 2)
  $name = "sprite_{0:D2}" -f $i
  $rect = New-Object System.Drawing.Rectangle $sx, $sy, $sw, $sh
  $crop = $bmp.Clone($rect, $bmp.PixelFormat)
  $outPath = Join-Path $outDir "$name.png"
  $crop.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  Write-Host ("{0}: x={1} y={2} w={3} h={4}" -f $name, $sx, $sy, $sw, $sh)
  $atlas[$name] = @{ x = $sx; y = $sy; w = $sw; h = $sh }
  $i++
}

$atlasPath = Join-Path $outDir "atlas.json"
($atlas.GetEnumerator() | ForEach-Object { [pscustomobject]@{ name = $_.Key; x = $_.Value.x; y = $_.Value.y; w = $_.Value.w; h = $_.Value.h } } | ConvertTo-Json) | Set-Content -Path $atlasPath -Encoding UTF8

# also copy track + concept as png/jpeg refs
Copy-Item (Join-Path $imgDir "f1786b024da15a2661c0530b92a74bdf.jpg") (Join-Path $outDir "track.jpg") -Force
Copy-Item (Join-Path $imgDir "3b452d27a322bdc34529ac7207953762.jpg") (Join-Path $outDir "concept.jpg") -Force
Copy-Item $sheetPath (Join-Path $outDir "sheet.jpg") -Force

$bmp.Dispose()
Write-Host "Done. Sprites: $i -> $outDir"

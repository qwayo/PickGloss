$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# 使用内存流处理本次框选；不把截图写入临时文件。
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $taskMethod = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Wait-Operation($operation, [Type]$resultType) {
    $task = $taskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
  }
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
  if ($request.sourceLanguage -ne 'auto') {
    $requested = [string]$request.sourceLanguage
    $prefix = switch ($requested) { 'zh-Hans' { 'zh-Hans' } 'zh-Hant' { 'zh-Hant' } default { $requested } }
    $languages = @($languages | Where-Object { $_.LanguageTag -eq $prefix -or $_.LanguageTag.StartsWith($prefix + '-', [StringComparison]::OrdinalIgnoreCase) })
  }
  if ($languages.Count -eq 0) {
    [Console]::Out.Write('{"ok":false,"code":"OCR_LANGUAGE_UNAVAILABLE"}')
    exit 1
  }
  $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $writer = [Windows.Storage.Streams.DataWriter]::new($stream.GetOutputStreamAt(0))
  $writer.WriteBytes([Convert]::FromBase64String($request.image))
  $null = Wait-Operation ($writer.StoreAsync()) ([uint32])
  $null = Wait-Operation ($writer.FlushAsync()) ([bool])
  $null = $writer.DetachStream()
  $writer.Dispose()
  $decoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $width = [int]$decoder.PixelWidth; $height = [int]$decoder.PixelHeight
  $limit = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $scale = [Math]::Min(1.0, $limit / [double][Math]::Max($width, $height))
  $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
  $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
  $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
  $bitmap = Wait-Operation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ratioX = $width / [double]$bitmap.PixelWidth; $ratioY = $height / [double]$bitmap.PixelHeight
  $candidates = @()
  # 自动模式尝试已安装的识别语言；它不是对任意图片语种的保证。
  foreach ($language in @($languages | Select-Object -First 8)) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) { continue }
    $recognized = Wait-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $blocks = @()
    foreach ($line in $recognized.Lines) {
      if ([string]::IsNullOrWhiteSpace($line.Text) -or $line.Words.Count -eq 0) { continue }
      $left = [double]::MaxValue; $top = [double]::MaxValue; $right = 0.0; $bottom = 0.0
      foreach ($word in $line.Words) {
        $box = $word.BoundingRect
        $left = [Math]::Min($left, $box.X); $top = [Math]::Min($top, $box.Y)
        $right = [Math]::Max($right, $box.X + $box.Width); $bottom = [Math]::Max($bottom, $box.Y + $box.Height)
      }
      $blocks += @{ text = [string]$line.Text; x = $left * $ratioX; y = $top * $ratioY; width = ($right - $left) * $ratioX; height = ($bottom - $top) * $ratioY }
    }
    $candidates += @{ language = $language.LanguageTag; angle = $recognized.TextAngle; blocks = @($blocks) }
  }
  $bitmap.Dispose(); $stream.Dispose()
  if ($candidates.Count -eq 0) { throw '本机没有可用的文字识别引擎。' }
  # 返回各个已安装引擎的结果，由桥接层按字符信号与文本结构选择，不按 CJK 字符数加分。
  [Console]::Out.Write((@{ ok = $true; candidates = @($candidates) } | ConvertTo-Json -Depth 10 -Compress))
} catch {
  [Console]::Out.Write('{"ok":false,"code":"OCR_UNAVAILABLE"}')
  exit 1
}

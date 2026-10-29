param([long]$WindowHandle, [uint32]$OwnerPid, [string]$SourcePath, [switch]$DragRightEdge, [switch]$Custom, [double]$X, [double]$Y, [double]$Dpr)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# 仅对归属已验证的隔离解释窗口执行命中查询，或按显式开关发送一次受控拖动。
$csharpSource = [System.IO.File]::ReadAllText($SourcePath, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($csharpSource)) { throw '原生命中查询源码为空。' }
Add-Type -TypeDefinition $csharpSource
if ($Custom) {
  [PanelResizeHitTest]::DragCustomRightEdge($WindowHandle, $OwnerPid, $X, $Y, $Dpr)
} elseif ($DragRightEdge) {
  [PanelResizeHitTest]::DragRightEdge($WindowHandle, $OwnerPid)
} else {
  [PanelResizeHitTest]::Inspect($WindowHandle, $OwnerPid)
}

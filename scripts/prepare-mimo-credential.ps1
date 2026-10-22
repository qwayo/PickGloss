param(
  [string]$OutputDirectory = $env:TEMP
)

$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$credentialPath = Join-Path $directory ('pickgloss-mimo-credential-' + [guid]::NewGuid().ToString('N') + '.xml')
$secret = Read-Host '请输入 MiMo 按量付费 API Key（输入内容不会显示）' -AsSecureString
if (-not $secret -or $secret.Length -eq 0) { throw '未输入 API Key；没有生成凭据文件。' }
$credential = [System.Management.Automation.PSCredential]::new('mimo', $secret)
$credential | Export-Clixml -LiteralPath $credentialPath
Write-Output $credentialPath
Write-Host '凭据仅由当前 Windows 用户通过 DPAPI 解密。请只把上面的文件路径告知代理，不要发送 API Key。'

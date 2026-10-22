param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Dpapi')]
  [string]$CredentialPath,
  [Parameter(Mandatory = $true, ParameterSetName = 'KeyFile')]
  [string]$KeyFilePath,
  [string]$KeyField = 'MIMO_API_KEY',
  [Parameter(Mandatory = $true)]
  [string]$CandidateRoot
)

$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ParameterSetName -eq 'Dpapi') {
  $credentialFile = Get-Item -LiteralPath $CredentialPath -ErrorAction Stop
  if ($credentialFile.PSIsContainer -or ($credentialFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '凭据路径必须是普通文件。'
  }
  $credential = Import-Clixml -LiteralPath $credentialFile.FullName
  if ($credential -isnot [System.Management.Automation.PSCredential] -or $credential.UserName -ne 'mimo') {
    throw '凭据格式无效。'
  }
  $secretValue = $credential.GetNetworkCredential().Password
} else {
  $keyFile = Get-Item -LiteralPath $KeyFilePath -ErrorAction Stop
  if ($keyFile.PSIsContainer -or ($keyFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '密钥路径必须是普通文件。'
  }
  $content = Get-Content -LiteralPath $keyFile.FullName -Raw -Encoding UTF8
  if ($content.TrimStart().StartsWith('{')) {
    try {
      $record = ConvertFrom-Json -InputObject $content -ErrorAction Stop
      $secretValue = $record.PSObject.Properties[$KeyField].Value
    } catch { throw 'JSON 密钥文件无法读取指定字段；请只告知字段名。' }
  } elseif ($content -match ('(?m)^\s*' + [regex]::Escape($KeyField) + '\s*=\s*([^\r\n]+)\s*$')) {
    $secretValue = $Matches[1].Trim().Trim('"', "'")
  } else {
    $secretValue = $content.Trim()
  }
}
if (-not $secretValue -or $secretValue.Length -gt 8192 -or $secretValue -match '[\r\n]') {
  throw '密钥文件内容不是可用的单个 API Key。'
}
$candidate = (Resolve-Path -LiteralPath $CandidateRoot).Path
$previous = [Environment]::GetEnvironmentVariable('MIMO_API_KEY', 'Process')
try {
  $env:MIMO_API_KEY = $secretValue
  & node (Join-Path $PSScriptRoot 'check-mimo-portable.cjs') $candidate
  if ($LASTEXITCODE -ne 0) { throw "MiMo 验收脚本失败，退出码：$LASTEXITCODE。" }
}
finally {
  [Environment]::SetEnvironmentVariable('MIMO_API_KEY', $previous, 'Process')
  $secretValue = $null
}

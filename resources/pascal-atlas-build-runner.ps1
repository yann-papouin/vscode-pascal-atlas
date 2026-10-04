$timer = [Diagnostics.Stopwatch]::StartNew()
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
# A previous completed build hides the otherwise distracting idle terminal
# caret. Restore it while this task is active, then hide it again at the end.
[Console]::Write(([char]27).ToString() + '[?25h')
$toolArgs = @()
if ($env:PASCAL_ATLAS_BUILD_ARGS) {
  $json = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:PASCAL_ATLAS_BUILD_ARGS)
  )
  $toolArgs = @($json | ConvertFrom-Json)
}

$errorCount = 0
$warningCount = 0
if ($env:PASCAL_ATLAS_BUILD_DIAGNOSTICS) {
  [IO.File]::WriteAllText($env:PASCAL_ATLAS_BUILD_DIAGNOSTICS, '', $utf8)
}
$displayTarget = $env:PASCAL_ATLAS_BUILD_LABEL -replace '^\S+\s+', ''
Write-Host ('Build ' + $displayTarget) -ForegroundColor Cyan
Write-Host ''

& $env:PASCAL_ATLAS_BUILD_TOOL @toolArgs 2>&1 | ForEach-Object {
  $line = [string]$_
  if ($line -match '^\s*Embarcadero Delphi for .+ compiler version ') {
    return
  }
  if ($line -match '^\s*Copyright \(c\) .+ Embarcadero Technologies, Inc\.\s*$') {
    return
  }
  if ($line -match '^\s*\d+\s+lines,\s+[\d.]+\s+seconds,\s+\d+\s+bytes code') {
    return
  }
  # MSBuild appends the owning DPROJ in square brackets. It is already known
  # from the target and makes the useful diagnostic wrap in narrow terminals.
  $displayLine = $line -replace '\s+\[[^\]]+\.dproj\]\s*$', ''
  $isError = $line -match '(?i)(?:\[dcc\w*\s+(?:fatal error|fatal|error)\]|(?:^|[:\s])(?:fatal error|fatal|error)\s*:?\s*[A-Z]+\d+\s*:)'
  $isWarning = $line -match '(?i)(?:\[dcc\w*\s+warning\]|(?:^|[:\s])warning\s*:?\s*[A-Z]+\d+\s*:)'
  if ($isError) {
    $errorCount++
    $diagnosticLine = '[ERROR] ' + $displayLine
    if ($env:PASCAL_ATLAS_BUILD_DIAGNOSTICS) {
      [IO.File]::AppendAllText($env:PASCAL_ATLAS_BUILD_DIAGNOSTICS, $diagnosticLine + [Environment]::NewLine, $utf8)
    }
    Write-Host $diagnosticLine -ForegroundColor Red
    return
  }
  if ($isWarning) {
    $warningCount++
    $diagnosticLine = '[WARN]  ' + $displayLine
    if ($env:PASCAL_ATLAS_BUILD_DIAGNOSTICS) {
      [IO.File]::AppendAllText($env:PASCAL_ATLAS_BUILD_DIAGNOSTICS, $diagnosticLine + [Environment]::NewLine, $utf8)
    }
    Write-Host $diagnosticLine -ForegroundColor Yellow
    return
  }
  Write-Host $displayLine
}

$code = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
$timer.Stop()
$state = if ($code -eq 0) { 'BUILD SUCCEEDED' } else { 'BUILD FAILED' }
$color = if ($code -eq 0) { 'Green' } else { 'Red' }
if ($env:PASCAL_ATLAS_BUILD_SUMMARY -ne 'false') {
  Write-Host ''
  Write-Host ($state + ': ' + $displayTarget) -ForegroundColor $color
  $errorLabel = if ($errorCount -eq 1) { '1 error' } else { $errorCount.ToString() + ' errors' }
  $warningLabel = if ($warningCount -eq 1) { '1 warning' } else { $warningCount.ToString() + ' warnings' }
  Write-Host ($errorLabel + ' | ' + $warningLabel + ' | ' + $timer.Elapsed.TotalSeconds.ToString('0.0') + 's')
}
[Console]::Write(([char]27).ToString() + '[?25l')

# VS Code prints the complete process command whenever a task process exits
# non-zero. Persist the real compiler result for the extension and let this
# small host task exit cleanly, so a Delphi error remains one concise line.
if ($env:PASCAL_ATLAS_BUILD_RESULT) {
  Set-Content -LiteralPath $env:PASCAL_ATLAS_BUILD_RESULT -Value $code -Encoding ASCII
}
exit 0

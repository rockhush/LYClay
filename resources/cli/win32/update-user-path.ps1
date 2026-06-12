param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('add', 'remove')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$CliDir,

  [ValidateSet('User', 'Machine')]
  [string]$Scope = 'Machine'
)

$ErrorActionPreference = 'Stop'

function Get-PathRegistryValue {
  param([ValidateSet('User', 'Machine')][string]$Scope)

  $raw = [Environment]::GetEnvironmentVariable('Path', $Scope)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString

  try {
    $registryPath = if ($Scope -eq 'Machine') {
      'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    } else {
      'Environment'
    }
    $baseKey = if ($Scope -eq 'Machine') {
      [Microsoft.Win32.Registry]::LocalMachine
    } else {
      [Microsoft.Win32.Registry]::CurrentUser
    }
    $key = $baseKey.OpenSubKey($registryPath, $false)
    if ($null -ne $key) {
      try {
        $stored = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $stored) {
          $raw = [string]$stored
        }
      } catch {
        # Fallback to Environment API value
      }

      try {
        $kind = $key.GetValueKind('Path')
      } catch {
        # Keep default ExpandString
      }
      $key.Close()
    }
  } catch {
    # Fallback to Environment API value
  }

  return @{
    Raw = $raw
    Kind = $kind
  }
}

function Normalize-PathEntry {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }

  return $Value.Trim().Trim('"').TrimEnd('\').ToLowerInvariant()
}

$pathMeta = Get-PathRegistryValue -Scope $Scope
$current = $pathMeta.Raw
$entries = @()
if (-not [string]::IsNullOrWhiteSpace($current)) {
  $entries = $current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

$target = Normalize-PathEntry $CliDir
$seen = [System.Collections.Generic.HashSet[string]]::new()
$nextEntries = New-Object System.Collections.Generic.List[string]

foreach ($entry in $entries) {
  $normalized = Normalize-PathEntry $entry
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    continue
  }

  if ($normalized -eq $target) {
    continue
  }

  if ($seen.Add($normalized)) {
    $nextEntries.Add($entry.Trim().Trim('"'))
  }
}

$status = 'already-present'
if ($Action -eq 'add') {
  if ($seen.Add($target)) {
    $nextEntries.Add($CliDir)
    $status = 'updated'
  }
} elseif ($entries.Count -ne $nextEntries.Count) {
  $status = 'updated'
}

$isLikelyCorruptedWrite = (
  $Action -eq 'add' -and
  $entries.Count -gt 1 -and
  $nextEntries.Count -le 1
)
if ($isLikelyCorruptedWrite) {
  throw "Refusing to rewrite user PATH: input had $($entries.Count) entries but output has $($nextEntries.Count)."
}

$newPath = if ($nextEntries.Count -eq 0) { $null } else { $nextEntries -join ';' }
try {
  $registryPath = if ($Scope -eq 'Machine') {
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  } else {
    'Environment'
  }
  $baseKey = if ($Scope -eq 'Machine') {
    [Microsoft.Win32.Registry]::LocalMachine
  } else {
    [Microsoft.Win32.Registry]::CurrentUser
  }
  $key = $baseKey.OpenSubKey($registryPath, $true)
  if ($null -eq $key) {
    throw "Unable to open $Scope environment registry key for write."
  }

  if ([string]::IsNullOrWhiteSpace($newPath)) {
    $key.DeleteValue('Path', $false)
  } else {
    $kind = if ($pathMeta.Kind -eq [Microsoft.Win32.RegistryValueKind]::String) {
      [Microsoft.Win32.RegistryValueKind]::String
    } else {
      [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    $key.SetValue('Path', $newPath, $kind)
  }
  $key.Close()
} catch {
  throw "Failed to write $Scope environment Path: $($_.Exception.Message)"
}

try {
  Add-Type -Namespace OpenClaw -Name NativeMethods -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(
  System.IntPtr hWnd,
  int Msg,
  System.IntPtr wParam,
  string lParam,
  int fuFlags,
  int uTimeout,
  out System.IntPtr lpdwResult
);
"@

  $result = [IntPtr]::Zero
  [OpenClaw.NativeMethods]::SendMessageTimeout(
    [IntPtr]0xffff,
    0x001A,
    [IntPtr]::Zero,
    'Environment',
    0x0002,
    5000,
    [ref]$result
  ) | Out-Null
} catch {
  Write-Warning "PATH updated but failed to broadcast environment change: $($_.Exception.Message)"
}

Write-Output $status

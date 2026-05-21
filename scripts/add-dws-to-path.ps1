# Add DWS CLI to PATH
$dwsDir = "$env:USERPROFILE\.dws"
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')

if ($userPath -like "*$dwsDir*") {
    Write-Host "DWS directory already in PATH"
} else {
    $newPath = "$userPath;$dwsDir"
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    Write-Host "PATH updated successfully"
    Write-Host "Added: $dwsDir"
}

# Register DingTalk as URI scheme in Windows
$dingtalkPath = "D:\Program Files\DingtalkScheme.exe"

$regPath = "HKCU:\SOFTWARE\Classes\dingtalk"
$shellPath = "$regPath\shell\open\command"

# Create the key structure
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value "URL:DingTalk Protocol"
Set-ItemProperty -Path $regPath -Name "URL Protocol" -Value ""

New-Item -Path $shellPath -Force | Out-Null
Set-ItemProperty -Path $shellPath -Name "(Default)" -Value "`"$dingtalkPath`" `"%1`""

Write-Host "DingTalk URI handler registered successfully."
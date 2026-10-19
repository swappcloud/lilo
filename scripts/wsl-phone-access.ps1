# Windows only: expose one WSL daemon port to phones on the selected LAN.
# Run in elevated Windows PowerShell. Native Linux/macOS need no WSL proxy.
param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [Parameter(Mandatory = $true)][System.Net.IPAddress]$ListenAddress,
    [ValidateRange(1024, 65535)][int]$Port = 8788,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script in elevated Windows PowerShell."
}
foreach ($tool in @("wsl.exe", "netsh.exe")) { Get-Command $tool -ErrorAction Stop | Out-Null }
if ($ListenAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "Use the Windows LAN IPv4 address."
}
$rule = "LiloDaemonWsl-$Port"
$address = $ListenAddress.ToString()
if ($Remove) {
    & netsh.exe interface portproxy delete v4tov4 "listenaddress=$address" "listenport=$Port" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not remove the WSL port proxy." }
    Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Output "LILO WSL phone access removed."
    return
}
$interface = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $address -ErrorAction Stop
$existing = Get-NetTCPConnection -LocalAddress $address -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing -and !(Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue)) {
    throw "Another service is listening on this address and port. Select another port."
}
$addresses = & wsl.exe --distribution $Distro --exec hostname -I
if ($LASTEXITCODE -ne 0) { throw "Could not obtain the WSL address. Check the distribution name."
}
$target = ($addresses.Trim() -split "\s+" | Where-Object { $_ -match "^\d+\.\d+\.\d+\.\d+$" } | Select-Object -First 1)
if (!$target) { throw "The WSL distribution has no IPv4 address."
}
& netsh.exe interface portproxy add v4tov4 "listenaddress=$address" "listenport=$Port" "connectaddress=$target" "connectport=$Port" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create the WSL port proxy."
}
Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name $rule -DisplayName "LILO daemon WSL phone access ($Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $address -RemoteAddress LocalSubnet -InterfaceAlias $interface.InterfaceAlias -Profile Any | Out-Null
Write-Output "Phone access: http://${address}:$Port (append the daemon pairing fragment)."

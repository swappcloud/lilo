//! IPv4 network choices for the LAN phone sign-in server.

use std::io::{Read, Write};
use std::net::{IpAddr, UdpSocket};

pub(crate) fn check_server(port: u16) -> Result<(), String> {
    let timeout = std::time::Duration::from_secs(2);
    let address = (std::net::Ipv4Addr::LOCALHOST, port).into();
    let check = || -> std::io::Result<()> {
        let mut stream = std::net::TcpStream::connect_timeout(&address, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut response = String::new();
        stream.take(4096).read_to_string(&mut response)?;
        if (response.starts_with("HTTP/1.0 200 ") || response.starts_with("HTTP/1.1 200 "))
            && response.contains("\"ok\":true")
        {
            Ok(())
        } else {
            Err(std::io::Error::other("unexpected server response"))
        }
    };
    check().map_err(|error| format!("The phone sign-in server did not respond on this computer: {error}. Close phone sign-in and retry."))
}

pub(crate) fn addresses() -> Result<Vec<(String, IpAddr)>, String> {
    let interfaces = local_ip_address::list_afinet_netifas()
        .map_err(|error| format!("Could not read network addresses: {error}"))?;
    // Connecting a UDP socket chooses a route without sending a packet or
    // requiring an Internet connection. Enumerated LAN choices remain usable
    // when the default route belongs to a VPN.
    let routed = UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
        .ok()
        .and_then(|socket| {
            socket
                .connect((std::net::Ipv4Addr::new(1, 1, 1, 1), 80))
                .ok()?;
            socket.local_addr().ok().map(|address| address.ip())
        });
    let choices = choose_addresses(interfaces, routed);
    if choices.is_empty() {
        return Err(
            "No LAN address found. Connect the computer and phone to the same network and retry."
                .into(),
        );
    }
    Ok(choices)
}

fn virtual_adapter(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "vethernet",
        "virtual",
        "vmware",
        "vbox",
        "hyper-v",
        "wsl",
        "docker",
        "tailscale",
        "wireguard",
        "vpn",
        "tunnel",
    ]
    .iter()
    .any(|part| name.contains(part))
        || ["utun", "tun", "tap", "virbr", "veth", "br-"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn choose_addresses(
    mut interfaces: Vec<(String, IpAddr)>,
    routed: Option<IpAddr>,
) -> Vec<(String, IpAddr)> {
    interfaces.retain(|(_, ip)| {
        matches!(ip, IpAddr::V4(ip) if !ip.is_loopback()
        && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_multicast() && !ip.is_broadcast())
    });
    interfaces.sort_by_key(|(name, ip)| (virtual_adapter(name), Some(*ip) != routed));
    let mut result = Vec::new();
    for interface in interfaces {
        if !result.iter().any(|(_, ip)| *ip == interface.1) {
            result.push(interface);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interface(name: &str, ip: &str) -> (String, std::net::IpAddr) {
        (name.into(), ip.parse().unwrap())
    }

    #[test]
    fn test_choices_prefer_lan_over_virtual_windows_adapters() {
        let choices = choose_addresses(
            vec![
                interface("vEthernet (Default Switch)", "172.20.16.1"),
                interface("Wi-Fi", "192.168.1.42"),
                interface("Ethernet", "192.168.1.43"),
            ],
            Some("172.20.16.1".parse().unwrap()),
        );
        assert_eq!(choices[0].1.to_string(), "192.168.1.42");
        assert_eq!(choices.len(), 3);
    }

    #[test]
    fn test_choices_prefer_route_within_lan_and_deduplicate() {
        let choices = choose_addresses(
            vec![
                interface("Ethernet", "10.0.0.3"),
                interface("Wi-Fi", "192.168.1.42"),
                interface("Wi-Fi duplicate", "192.168.1.42"),
                interface("Loopback", "127.0.0.1"),
                interface("Disconnected", "0.0.0.0"),
                interface("Unconfigured", "169.254.1.2"),
                interface("IPv6", "2001:db8::1"),
            ],
            Some("192.168.1.42".parse().unwrap()),
        );
        assert_eq!(choices[0].1.to_string(), "192.168.1.42");
        assert_eq!(choices.len(), 2);
    }

    #[test]
    fn test_choices_preserve_vpn_as_an_alternative_and_support_offline_lan() {
        let choices = choose_addresses(
            vec![
                interface("WireGuard", "10.8.0.2"),
                interface("en0", "192.168.1.42"),
            ],
            None,
        );
        assert_eq!(choices[0].0, "en0");
        assert_eq!(choices[1].0, "WireGuard");
        assert!(choose_addresses(vec![interface("lo", "127.0.0.1")], None).is_empty());
    }
}

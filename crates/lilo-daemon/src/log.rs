//! Console output. systemd adds timestamps and captures stdout, so the daemon
//! keeps it to a prefix and one line per event — no logging framework to carry
//! on a board with 1 GB of RAM.

pub fn info(message: impl AsRef<str>) {
    println!("[lilo] {}", message.as_ref());
}

pub fn warn(message: impl AsRef<str>) {
    eprintln!("[lilo] warning: {}", message.as_ref());
}

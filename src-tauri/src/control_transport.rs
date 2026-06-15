//! Transport seam for the inter-pane control bus (ADR-0007 / PLAN M7.5).
//!
//! The line protocol — one JSON request line in, one JSON response line out — is platform-neutral
//! and lives in `control.rs` (the relay) and `control_sock.rs` (the `th` / `th-mcp` client). This
//! module is the ONLY place that knows *how the bytes travel*: a unix-domain socket today, behind
//! `#[cfg(unix)]`. The Windows named-pipe transport (M7.5) drops in here behind `#[cfg(windows)]`
//! by providing the same items — `Stream`, `Listener`, `endpoint`, `connect`, `bind`,
//! `probe_alive` — so neither the relay nor the client changes. Splitting it out now (Linux-only)
//! lets the seam be proven before any Windows code exists.
//!
//! Shared by the lib (`control.rs`) and both bins (`control_sock.rs`, pulled in via `#[path]`), so
//! it stays std-only — no Tauri, matching `control_sock.rs`. The platform `Stream` must implement
//! `Read`/`Write` on a *shared* `&Stream` (as `UnixStream` does), so the relay can read and write
//! over one borrowed handle without cloning it.

// Each side uses a different subset (the client connects + frames; the relay binds + accepts), so
// some items are unused per-target — the seam is deliberately whole, not trimmed to one caller.
#![allow(dead_code, unused_imports)]

use std::io::{self, BufRead, BufReader, Read, Write};

/// Write one newline-terminated line and flush. Transport-neutral framing.
pub fn write_line<W: Write>(mut w: W, payload: &str) -> io::Result<()> {
    w.write_all(payload.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// Read one newline-terminated line, trimmed of the trailing newline. `Ok(None)` on EOF or a
/// blank line — callers treat both as "nothing to do".
pub fn read_line<R: Read>(r: R) -> io::Result<Option<String>> {
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None); // EOF
    }
    let trimmed = line.trim_end();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

#[cfg(unix)]
pub use unix::{bind, connect, endpoint, probe_alive, Listener, Stream};

#[cfg(windows)]
pub use windows::{bind, connect, endpoint, probe_alive, Listener, Stream};

#[cfg(unix)]
mod unix {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;

    /// A connected bus stream. `&UnixStream` implements both `Read` and `Write`, so the relay reads
    /// and writes over a shared `&Stream` without cloning the handle.
    pub type Stream = UnixStream;
    /// Accepts connections via `.incoming()` (used by the relay's accept loop).
    pub type Listener = UnixListener;

    /// The server's bind address, also injected to pane children as `$TERMHAUS_SOCK`. Prefer
    /// `$XDG_RUNTIME_DIR` (a per-user, 0700 dir on every systemd Linux); fall back to a per-user
    /// name in `/tmp`. Same-user access is the whole trust boundary (ADR-0007) — the principals who
    /// can connect are exactly those who could already drive these terminals another way.
    pub fn endpoint() -> String {
        socket_path().to_string_lossy().into_owned()
    }

    fn socket_path() -> PathBuf {
        if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            let p = PathBuf::from(dir);
            if p.is_dir() {
                return p.join("termhaus.sock");
            }
        }
        let who = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "user".to_string());
        std::env::temp_dir().join(format!("termhaus-{who}.sock"))
    }

    /// Connect to a running relay (the client reads the address from `$TERMHAUS_SOCK`).
    pub fn connect(addr: &str) -> io::Result<Stream> {
        UnixStream::connect(addr)
    }

    /// True if a live relay is already accepting at `addr` (vs a stale socket file left by a crash).
    pub fn probe_alive(addr: &str) -> bool {
        UnixStream::connect(addr).is_ok()
    }

    /// Bind a listener at `addr`, clearing any stale socket file first and restricting it to the
    /// owner (0600, belt-and-suspenders on the 0700 runtime dir). Callers MUST `probe_alive` first
    /// so a *live* instance is never clobbered.
    pub fn bind(addr: &str) -> io::Result<Listener> {
        let _ = std::fs::remove_file(addr);
        let listener = UnixListener::bind(addr)?;
        let _ = std::fs::set_permissions(addr, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }
}

#[cfg(windows)]
mod windows {
    //! Windows transport over a **named pipe** (`\\.\pipe\termhaus-<user>`), the analogue of the
    //! unix UDS. Built on raw Win32 FFI (`windows-sys`) to avoid a cross-platform dependency. The
    //! pipe is created with an owner-only DACL — the Windows equivalent of the UDS `0600` chmod, so
    //! only the same user (plus the machine's admins, who could drive these terminals anyway) can
    //! reach the bus. `PIPE_REJECT_REMOTE_CLIENTS` blocks network access. The relay and clients use
    //! the same `endpoint`/`connect`/`bind`/`probe_alive` items as on unix — they never see this.
    //!
    //! NOTE: written and compile-checked from Linux (`cargo check --target x86_64-pc-windows-gnu`);
    //! runtime behaviour is verified on a Windows VM (M7.4), not here.

    use std::io::{self, Read, Write};
    use std::mem;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, ReadFile, WriteFile,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, WaitNamedPipeW,
    };

    // Plain integer flags/codes used by the calls above. Defined locally (rather than imported)
    // because their `windows-sys` module paths shift between releases — the numeric values are
    // stable ABI. All are `u32` to match the FFI signatures; the error codes are `i32` to compare
    // against `io::Error::raw_os_error()`.
    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
    const PIPE_UNLIMITED_INSTANCES: u32 = 255;
    const PIPE_BUFFER_SIZE: u32 = 64 * 1024;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const SDDL_REVISION_1: u32 = 1;
    const ERROR_BROKEN_PIPE: i32 = 109;
    const ERROR_PIPE_BUSY: i32 = 231;
    const ERROR_PIPE_CONNECTED: i32 = 535;
    /// How long `connect` waits for a free pipe instance when all are busy (ms), and how many
    /// times it retries the wait→open cycle before giving up.
    const CONNECT_WAIT_MS: u32 = 5_000;
    const CONNECT_MAX_RETRIES: u32 = 10;

    /// Encode a `&str` as a NUL-terminated UTF-16 buffer for the `*W` Win32 calls.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The bus address, also injected to pane children as `$TERMHAUS_SOCK`. A per-user pipe name so
    /// two users' instances don't collide; the name is *not* the trust boundary (the DACL is), so a
    /// best-effort identity is enough. Non-alphanumerics are squashed to `_` (pipe names forbid `\`).
    pub fn endpoint() -> String {
        let who = std::env::var("USERNAME")
            .or_else(|_| {
                std::env::var("USERPROFILE")
                    .map(|p| p.rsplit(['\\', '/']).next().unwrap_or("user").to_string())
            })
            .unwrap_or_else(|_| "user".to_string());
        let safe: String = who
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        format!(r"\\.\pipe\termhaus-{safe}")
    }

    /// Owns the security descriptor allocated by `ConvertStringSecurityDescriptor...`; freed with
    /// `LocalFree` (as the API requires) when the listener is dropped.
    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
    // The raw pointer is only ever read by the kernel via `SECURITY_ATTRIBUTES`; moving the owning
    // Listener across threads (the relay's accept thread) is safe.
    unsafe impl Send for SecurityDescriptor {}
    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0 as _);
            }
        }
    }

    /// Build a DACL that grants full access only to the object OWNER (the creating user),
    /// LocalSystem, and Administrators — everyone else is denied by omission. `P` makes it
    /// protected (no inherited ACEs). This is the named-pipe analogue of the UDS `0600` perms.
    fn owner_only_security() -> io::Result<SecurityDescriptor> {
        let sddl = wide("D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;BA)");
        let mut psd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut psd,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(SecurityDescriptor(psd))
    }

    /// A connected bus stream — one named-pipe instance (server side) or an opened client handle.
    /// `&Stream` implements `Read`/`Write` so the relay serves a whole request/response over one
    /// borrowed handle, exactly like `&UnixStream`.
    pub struct Stream {
        handle: isize,
        /// Server handles get a graceful flush+disconnect on drop; client handles just close.
        is_server: bool,
    }
    // The handle is owned exclusively and used from one thread at a time.
    unsafe impl Send for Stream {}

    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                if self.is_server {
                    // Block until the client has drained the response, then tear the instance down.
                    FlushFileBuffers(self.handle as _);
                    DisconnectNamedPipe(self.handle as _);
                }
                CloseHandle(self.handle as _);
            }
        }
    }

    impl Read for &Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut read: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    self.handle as _,
                    buf.as_mut_ptr().cast(),
                    buf.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                // The peer closing its end is a normal EOF, not an error.
                if err.raw_os_error() == Some(ERROR_BROKEN_PIPE) {
                    return Ok(0);
                }
                return Err(err);
            }
            Ok(read as usize)
        }
    }

    impl Write for &Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut written: u32 = 0;
            let ok = unsafe {
                WriteFile(
                    self.handle as _,
                    buf.as_ptr(),
                    buf.len() as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(written as usize)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(()) // WriteFile is synchronous to the pipe; nothing is buffered on our side.
        }
    }

    /// Accepts connections by creating a fresh pipe instance per client (Win32 has no `accept`;
    /// each `CreateNamedPipeW`/`ConnectNamedPipe` pair serves exactly one connection).
    pub struct Listener {
        name: Vec<u16>,
        security: SecurityDescriptor,
    }
    // `name` is `Send`; `security` is `Send` (impl above), so the whole Listener moves to the
    // relay's accept thread safely.

    impl Listener {
        /// Yields one connected `Stream` per client, forever — mirrors `UnixListener::incoming()`.
        pub fn incoming(&self) -> Incoming<'_> {
            Incoming { listener: self }
        }

        fn accept(&self) -> io::Result<Stream> {
            let sa = SECURITY_ATTRIBUTES {
                nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.security.0,
                bInheritHandle: 0,
            };
            let handle = unsafe {
                CreateNamedPipeW(
                    self.name.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    PIPE_BUFFER_SIZE,
                    PIPE_BUFFER_SIZE,
                    0,
                    &sa,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            // Block until a client opens the pipe. ERROR_PIPE_CONNECTED means one arrived in the
            // gap between create and connect — still a success.
            let connected = unsafe { ConnectNamedPipe(handle as _, ptr::null_mut()) };
            if connected == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(ERROR_PIPE_CONNECTED) {
                    unsafe { CloseHandle(handle as _) };
                    return Err(err);
                }
            }
            Ok(Stream {
                handle: handle as isize,
                is_server: true,
            })
        }
    }

    pub struct Incoming<'a> {
        listener: &'a Listener,
    }
    impl Iterator for Incoming<'_> {
        type Item = io::Result<Stream>;
        fn next(&mut self) -> Option<Self::Item> {
            Some(self.listener.accept())
        }
    }

    /// Bind the bus: capture the pipe name + owner-only security descriptor. Instances are created
    /// lazily per accept (Win32 has no separate bind step). Callers MUST `probe_alive` first so a
    /// live instance is never shadowed.
    pub fn bind(addr: &str) -> io::Result<Listener> {
        Ok(Listener {
            name: wide(addr),
            security: owner_only_security()?,
        })
    }

    /// Connect to a running relay. Retries through `ERROR_PIPE_BUSY` (all instances momentarily in
    /// use) by waiting for a free instance, since the relay creates the next instance only after a
    /// client connects to the current one.
    pub fn connect(addr: &str) -> io::Result<Stream> {
        let name = wide(addr);
        for _ in 0..CONNECT_MAX_RETRIES {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    0,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Stream {
                    handle: handle as isize,
                    is_server: false,
                });
            }
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(ERROR_PIPE_BUSY) {
                return Err(err);
            }
            // All instances busy — wait for one to free, then retry.
            if unsafe { WaitNamedPipeW(name.as_ptr(), CONNECT_WAIT_MS) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "named pipe stayed busy after retries",
        ))
    }

    /// True if a live relay is accepting at `addr`. A successful open means yes; `ERROR_PIPE_BUSY`
    /// also means yes (server up, just no free instance this instant). Anything else (typically
    /// `ERROR_FILE_NOT_FOUND`) means no server — the address is free to bind.
    pub fn probe_alive(addr: &str) -> bool {
        let name = wide(addr);
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(handle as _) };
            return true;
        }
        io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_BUSY)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{read_line, write_line};
    use std::os::unix::net::UnixStream;

    #[test]
    fn line_framing_round_trips() {
        let (a, b) = UnixStream::pair().unwrap();
        let req = r#"{"op":"list"}"#;
        write_line(&a, req).unwrap();
        assert_eq!(read_line(&b).unwrap().as_deref(), Some(req));
    }

    #[test]
    fn read_line_is_none_on_eof() {
        let (a, b) = UnixStream::pair().unwrap();
        drop(a); // close the write end → EOF on the read end
        assert_eq!(read_line(&b).unwrap(), None);
    }

    #[test]
    fn read_line_treats_blank_as_none() {
        let (a, b) = UnixStream::pair().unwrap();
        write_line(&a, "   ").unwrap(); // whitespace-only trims to empty → "nothing to do"
        assert_eq!(read_line(&b).unwrap(), None);
    }
}

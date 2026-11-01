use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_READY_LINE_BYTES: usize = 16 * 1024;
const MAX_REQUEST_PATH_BYTES: usize = 8 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_HEADERS_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeLaunchSpec {
    pub node_executable: PathBuf,
    pub runtime_script: PathBuf,
    pub working_directory: PathBuf,
    pub args: Vec<String>,
    pub token_env: String,
    pub approval_token_env: String,
    pub token: String,
    pub approval_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RuntimeReady {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeLauncherError {
    RelativeNodeExecutable,
    RelativeRuntimeScript,
    RelativeWorkingDirectory,
    EmptyArgument,
    TokenInArguments,
    TokenEnvironmentInvalid,
    SpawnFailed,
    ReadyTimeout,
    ReadyOutputInvalid,
    ReadyHostInvalid,
    ReadyPortInvalid,
    IoFailed,
    RequestPathInvalid,
    RequestBodyTooLarge,
    ResponseTooLarge,
    ApprovalHeaderNotAllowed,
    RequestFailed,
    ShutdownRejected,
    StopTimeout,
}

pub struct RuntimeProcess {
    child: Child,
    pub ready: RuntimeReady,
}

impl RuntimeProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop_gracefully(
        &mut self,
        token: &str,
        approval_token: &str,
    ) -> Result<(), RuntimeLauncherError> {
        if self.has_exited()? {
            return Ok(());
        }
        request_shutdown(&self.ready, token, approval_token)?;
        if wait_for_exit(&mut self.child, STOP_TIMEOUT)? {
            Ok(())
        } else {
            Err(RuntimeLauncherError::StopTimeout)
        }
    }

    pub fn force_stop(&mut self) -> Result<(), RuntimeLauncherError> {
        force_kill_and_wait(&mut self.child)
    }

    pub fn stop(&mut self, token: &str, approval_token: &str) -> Result<(), RuntimeLauncherError> {
        if matches!(self.has_exited(), Ok(true)) {
            return Ok(());
        }
        if self.stop_gracefully(token, approval_token).is_ok() {
            return Ok(());
        }
        self.force_stop()
    }

    fn has_exited(&mut self) -> Result<bool, RuntimeLauncherError> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|_| RuntimeLauncherError::IoFailed)
    }
}

impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        let _ = self.force_stop();
    }
}

impl RuntimeLaunchSpec {
    pub fn validate(&self) -> Result<(), RuntimeLauncherError> {
        if !self.node_executable.is_absolute() {
            return Err(RuntimeLauncherError::RelativeNodeExecutable);
        }
        if !self.runtime_script.is_absolute() {
            return Err(RuntimeLauncherError::RelativeRuntimeScript);
        }
        if !self.working_directory.is_absolute() {
            return Err(RuntimeLauncherError::RelativeWorkingDirectory);
        }
        if self.args.iter().any(|arg| arg.is_empty()) {
            return Err(RuntimeLauncherError::EmptyArgument);
        }
        if self
            .args
            .iter()
            .any(|arg| arg == &self.token || arg == &self.approval_token)
        {
            return Err(RuntimeLauncherError::TokenInArguments);
        }
        if self.token_env.is_empty()
            || self.approval_token_env.is_empty()
            || self.token_env == self.approval_token_env
        {
            return Err(RuntimeLauncherError::TokenEnvironmentInvalid);
        }
        Ok(())
    }

    pub fn cli_args(&self) -> Vec<String> {
        self.args.clone()
    }

    pub fn spawn(&self) -> Result<RuntimeProcess, RuntimeLauncherError> {
        self.validate()?;
        let mut command = Command::new(&self.node_executable);
        command
            .arg(&self.runtime_script)
            .args(&self.args)
            .current_dir(&self.working_directory)
            .env(&self.token_env, &self.token)
            .env(&self.approval_token_env, &self.approval_token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| RuntimeLauncherError::SpawnFailed)?;
        drain_stderr(child.stderr.take());
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                return Err(cleanup_spawn_failure(
                    child,
                    RuntimeLauncherError::SpawnFailed,
                ));
            }
        };
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let read_result = {
                let mut limited = reader.by_ref().take((MAX_READY_LINE_BYTES + 1) as u64);
                limited.read_until(b'\n', &mut line)
            };
            let result = match read_result {
                Ok(length) if length <= MAX_READY_LINE_BYTES => {
                    String::from_utf8(line).map_err(|_| RuntimeLauncherError::ReadyOutputInvalid)
                }
                Ok(_) => Err(RuntimeLauncherError::ReadyOutputInvalid),
                Err(_) => Err(RuntimeLauncherError::IoFailed),
            };
            let _ = sender.send(result);
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let line = match receiver.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => return Err(cleanup_spawn_failure(child, error)),
            Err(RecvTimeoutError::Timeout) => {
                return Err(cleanup_spawn_failure(
                    child,
                    RuntimeLauncherError::ReadyTimeout,
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(cleanup_spawn_failure(
                    child,
                    RuntimeLauncherError::ReadyOutputInvalid,
                ));
            }
        };
        let ready = match parse_ready(&line) {
            Ok(ready) => ready,
            Err(error) => return Err(cleanup_spawn_failure(child, error)),
        };
        Ok(RuntimeProcess { child, ready })
    }
}

fn cleanup_spawn_failure(mut child: Child, original: RuntimeLauncherError) -> RuntimeLauncherError {
    match force_kill_and_wait(&mut child) {
        Ok(()) => original,
        Err(cleanup_error) => cleanup_error,
    }
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<bool, RuntimeLauncherError> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(true),
            Ok(None) => {}
            Err(_) => return Err(RuntimeLauncherError::IoFailed),
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(windows)]
fn taskkill_path() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join("taskkill.exe")
}

#[cfg(windows)]
fn taskkill_tree(pid: u32) -> bool {
    let mut taskkill = match Command::new(taskkill_path())
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(taskkill) => taskkill,
        Err(_) => return false,
    };
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        match taskkill.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            let _ = taskkill.kill();
            let _ = wait_for_exit(&mut taskkill, STOP_TIMEOUT);
            return false;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn force_kill_and_wait(child: &mut Child) -> Result<(), RuntimeLauncherError> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        if taskkill_tree(child.id()) && matches!(wait_for_exit(child, STOP_TIMEOUT), Ok(true)) {
            return Ok(());
        }
    }
    kill_direct_and_wait(child)
}

fn kill_direct_and_wait(child: &mut Child) -> Result<(), RuntimeLauncherError> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    if child.kill().is_err() {
        return match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) | Err(_) => Err(RuntimeLauncherError::IoFailed),
        };
    }
    if wait_for_exit(child, STOP_TIMEOUT)? {
        Ok(())
    } else {
        Err(RuntimeLauncherError::StopTimeout)
    }
}

fn drain_stderr(stderr: Option<impl Read + Send + 'static>) {
    if let Some(mut stderr) = stderr {
        thread::spawn(move || {
            let mut buffer = [0_u8; 1024];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
}

fn parse_ready(line: &str) -> Result<RuntimeReady, RuntimeLauncherError> {
    #[derive(Deserialize)]
    struct ReadyEnvelope {
        service: Option<RuntimeReady>,
    }
    let envelope: ReadyEnvelope =
        serde_json::from_str(line).map_err(|_| RuntimeLauncherError::ReadyOutputInvalid)?;
    let service = envelope
        .service
        .ok_or(RuntimeLauncherError::ReadyOutputInvalid)?;
    if !matches!(service.host.as_str(), "127.0.0.1" | "::1" | "localhost") {
        return Err(RuntimeLauncherError::ReadyHostInvalid);
    }
    if service.port == 0 {
        return Err(RuntimeLauncherError::ReadyPortInvalid);
    }
    Ok(service)
}

pub fn runtime_script_from(repo_root: &Path) -> PathBuf {
    repo_root.join("bin").join("workbench.mjs")
}

pub fn generate_token() -> Result<String, RuntimeLauncherError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RuntimeLauncherError::IoFailed)?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut token, "{byte:02x}");
    }
    Ok(token)
}

pub fn runtime_request(
    ready: &RuntimeReady,
    token: &str,
    approval_token: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    approval: bool,
) -> Result<(u16, String), RuntimeLauncherError> {
    runtime_request_inner(
        ready,
        token,
        approval_token,
        method,
        path,
        body,
        approval,
        false,
    )
}

fn runtime_request_inner(
    ready: &RuntimeReady,
    token: &str,
    approval_token: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    approval: bool,
    allow_shutdown: bool,
) -> Result<(u16, String), RuntimeLauncherError> {
    validate_request(method, path, body, approval, allow_shutdown)?;
    let socket = socket_address(ready)?;
    let mut stream = TcpStream::connect_timeout(&socket, REQUEST_TIMEOUT)
        .map_err(|_| RuntimeLauncherError::RequestFailed)?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|_| RuntimeLauncherError::RequestFailed)?;
    let payload = body.unwrap_or("");
    let host_header = if ready.host == "::1" {
        format!("[{}]:{}", ready.host, ready.port)
    } else {
        format!("{}:{}", ready.host, ready.port)
    };
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAuthorization: Bearer {token}\r\n"
    );
    if approval {
        request.push_str(&format!("x-approval-token: {approval_token}\r\n"));
    }
    if !payload.is_empty() {
        request.push_str(&format!(
            "content-type: application/json\r\ncontent-length: {}\r\n",
            payload.len()
        ));
    }
    request.push_str("\r\n");
    request.push_str(payload);
    stream
        .write_all(request.as_bytes())
        .map_err(|_| RuntimeLauncherError::RequestFailed)?;
    let _ = stream.shutdown(Shutdown::Write);
    let mut response = Vec::new();
    let max_wire_bytes = MAX_RESPONSE_BYTES + MAX_RESPONSE_HEADERS_BYTES + 1;
    stream
        .take(max_wire_bytes as u64)
        .read_to_end(&mut response)
        .map_err(|_| RuntimeLauncherError::RequestFailed)?;
    if response.len() > max_wire_bytes - 1 {
        return Err(RuntimeLauncherError::ResponseTooLarge);
    }
    decode_http_response(&response)
}

fn request_shutdown(
    ready: &RuntimeReady,
    token: &str,
    approval_token: &str,
) -> Result<(), RuntimeLauncherError> {
    let (status, _) = runtime_request_inner(
        ready,
        token,
        approval_token,
        "POST",
        "/v1/shutdown",
        None,
        false,
        true,
    )?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(RuntimeLauncherError::ShutdownRejected)
    }
}

fn decode_http_response(response: &[u8]) -> Result<(u16, String), RuntimeLauncherError> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(RuntimeLauncherError::RequestFailed)?;
    if header_end > MAX_RESPONSE_HEADERS_BYTES {
        return Err(RuntimeLauncherError::ResponseTooLarge);
    }
    let head = std::str::from_utf8(&response[..header_end])
        .map_err(|_| RuntimeLauncherError::RequestFailed)?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or(RuntimeLauncherError::RequestFailed)?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| RuntimeLauncherError::RequestFailed)?,
                );
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
            }
        }
    }
    let wire_body = &response[header_end + 4..];
    let body = if chunked {
        decode_chunked_body(wire_body)?
    } else {
        if content_length
            .map(|length| length > MAX_RESPONSE_BYTES)
            .unwrap_or(false)
        {
            return Err(RuntimeLauncherError::ResponseTooLarge);
        }
        if let Some(length) = content_length {
            if wire_body.len() < length {
                return Err(RuntimeLauncherError::RequestFailed);
            }
            wire_body[..length].to_vec()
        } else {
            wire_body.to_vec()
        }
    };
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(RuntimeLauncherError::ResponseTooLarge);
    }
    let body = std::str::from_utf8(&body).map_err(|_| RuntimeLauncherError::RequestFailed)?;
    Ok((status, body.to_string()))
}

fn decode_chunked_body(mut wire_body: &[u8]) -> Result<Vec<u8>, RuntimeLauncherError> {
    let mut body = Vec::new();
    loop {
        let line_end = wire_body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or(RuntimeLauncherError::RequestFailed)?;
        let size_line = std::str::from_utf8(&wire_body[..line_end])
            .map_err(|_| RuntimeLauncherError::RequestFailed)?;
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| RuntimeLauncherError::RequestFailed)?;
        wire_body = &wire_body[line_end + 2..];
        if size == 0 {
            return Ok(body);
        }
        if size > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
            return Err(RuntimeLauncherError::ResponseTooLarge);
        }
        if wire_body.len() < size.saturating_add(2) || &wire_body[size..size + 2] != b"\r\n" {
            return Err(RuntimeLauncherError::RequestFailed);
        }
        body.extend_from_slice(&wire_body[..size]);
        wire_body = &wire_body[size + 2..];
    }
}

fn socket_address(ready: &RuntimeReady) -> Result<std::net::SocketAddr, RuntimeLauncherError> {
    let ip = match ready.host.as_str() {
        "127.0.0.1" | "localhost" => std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        "::1" => std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        _ => return Err(RuntimeLauncherError::RequestFailed),
    };
    if ready.port == 0 {
        return Err(RuntimeLauncherError::RequestFailed);
    }
    Ok(std::net::SocketAddr::new(ip, ready.port))
}

fn validate_request(
    method: &str,
    path: &str,
    body: Option<&str>,
    approval: bool,
    allow_shutdown: bool,
) -> Result<(), RuntimeLauncherError> {
    let pathname = path.split_once('?').map_or(path, |(value, _)| value);
    if !matches!(method, "GET" | "POST" | "DELETE")
        || path.is_empty()
        || path.len() > MAX_REQUEST_PATH_BYTES
        || !path.starts_with('/')
        || path
            .bytes()
            .any(|byte| byte <= 0x20 || byte == 0x7f || byte == b'#')
        || pathname == "/"
        || pathname == "/ui"
        || pathname == "/v1/events/stream"
        || (!allow_shutdown && pathname == "/v1/shutdown")
        || (allow_shutdown && (method != "POST" || pathname != "/v1/shutdown"))
        || path.contains("..")
        || path.contains('\\')
        || path.contains('\r')
        || path.contains('\n')
        || (!pathname.starts_with("/v1/") && pathname != "/health")
    {
        return Err(RuntimeLauncherError::RequestPathInvalid);
    }
    if approval && !approval_header_allowed(method, pathname) {
        return Err(RuntimeLauncherError::ApprovalHeaderNotAllowed);
    }
    if body
        .map(|value| value.len() > MAX_REQUEST_BODY_BYTES)
        .unwrap_or(false)
    {
        return Err(RuntimeLauncherError::RequestBodyTooLarge);
    }
    Ok(())
}

fn approval_header_allowed(method: &str, pathname: &str) -> bool {
    if method != "POST" {
        return false;
    }
    let segments: Vec<_> = pathname.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["v1", "models", id, operation] => {
            !id.is_empty() && matches!(*operation, "health" | "approve")
        }
        ["v1", "mcp", "servers", id, "approve"] => !id.is_empty(),
        ["v1", "config", id, "approve"] => !id.is_empty(),
        ["v1", "terminal", "sessions"] => true,
        ["v1", "terminal", "sessions", id, operation] => {
            is_uuid_path_segment(id) && matches!(*operation, "input" | "cancel")
        }
        ["v1", "proposals", id, operation] => {
            !id.is_empty() && matches!(*operation, "approve" | "deny" | "cancel")
        }
        _ => false,
    }
}

fn is_uuid_path_segment(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod request_tests {
    use super::*;

    #[test]
    fn formats_loopback_socket_addresses_for_ipv4_ipv6_and_localhost() {
        assert_eq!(
            socket_address(&RuntimeReady {
                host: "127.0.0.1".into(),
                port: 4312,
            })
            .unwrap(),
            "127.0.0.1:4312".parse().unwrap()
        );
        assert_eq!(
            socket_address(&RuntimeReady {
                host: "::1".into(),
                port: 4312,
            })
            .unwrap(),
            "[::1]:4312".parse().unwrap()
        );
        assert_eq!(
            socket_address(&RuntimeReady {
                host: "localhost".into(),
                port: 4312,
            })
            .unwrap(),
            "127.0.0.1:4312".parse().unwrap()
        );
    }

    #[test]
    fn runtime_requests_reject_non_loopback_hosts() {
        assert_eq!(
            socket_address(&RuntimeReady {
                host: "0.0.0.0".into(),
                port: 4312,
            }),
            Err(RuntimeLauncherError::RequestFailed)
        );
    }

    #[test]
    fn request_paths_are_bounded_and_cannot_reach_ui_stream_or_shutdown() {
        for path in [
            "https://example.test/v1/status",
            "/ui",
            "/",
            "/v1/events/stream",
            "/v1/shutdown",
            "/v1/shutdown?source=frontend",
            "/v1/events/stream?after=0",
            "/v1/../health",
            "/v1/x\\y",
            "/v1/x\r\nHost: attacker",
        ] {
            assert_eq!(
                validate_request("GET", path, None, false, false),
                Err(RuntimeLauncherError::RequestPathInvalid),
                "accepted path: {path:?}"
            );
        }
        assert_eq!(
            validate_request("POST", "/v1/shutdown", None, false, true),
            Ok(())
        );
        assert_eq!(
            validate_request(
                "GET",
                &format!("/v1/{}", "x".repeat(MAX_REQUEST_PATH_BYTES)),
                None,
                false,
                false
            ),
            Err(RuntimeLauncherError::RequestPathInvalid)
        );
    }

    #[test]
    fn graceful_stop_accepts_ephemeral_manager_tokens() {
        let _: fn(&mut RuntimeProcess, &str, &str) -> Result<(), RuntimeLauncherError> =
            RuntimeProcess::stop_gracefully;
        let _: fn(&mut RuntimeProcess, &str, &str) -> Result<(), RuntimeLauncherError> =
            RuntimeProcess::stop;
        let _: fn(&mut RuntimeProcess) -> Result<(), RuntimeLauncherError> =
            RuntimeProcess::force_stop;
    }

    #[test]
    fn request_body_is_bounded() {
        assert_eq!(
            validate_request(
                "POST",
                "/v1/sessions",
                Some(&"x".repeat(MAX_REQUEST_BODY_BYTES + 1)),
                false,
                false
            ),
            Err(RuntimeLauncherError::RequestBodyTooLarge)
        );
        assert_eq!(
            validate_request("PATCH", "/v1/sessions", None, false, false),
            Err(RuntimeLauncherError::RequestPathInvalid)
        );
    }

    #[test]
    fn approval_header_is_limited_to_runtime_approval_routes() {
        for path in [
            "/v1/models/primary/health",
            "/v1/models/primary/approve",
            "/v1/mcp/servers/local/approve",
            "/v1/config/action-123/approve",
            "/v1/terminal/sessions",
            "/v1/terminal/sessions/01234567-89ab-cdef-0123-456789abcdef/input",
            "/v1/terminal/sessions/01234567-89ab-cdef-0123-456789abcdef/cancel",
            "/v1/proposals/action-123/approve",
            "/v1/proposals/action-123/deny",
            "/v1/proposals/action-123/cancel",
        ] {
            assert!(approval_header_allowed("POST", path), "not allowed: {path}");
        }
        for (method, path) in [
            ("GET", "/v1/models/primary/health"),
            ("POST", "/v1/status"),
            ("POST", "/v1/proposals/action-123"),
            ("POST", "/v1/shutdown?source=frontend"),
            ("POST", "/v1/terminal/sessions/not-a-uuid/input"),
        ] {
            assert!(
                !approval_header_allowed(method, path),
                "unexpectedly allowed: {method} {path}"
            );
        }
        assert_eq!(
            validate_request("POST", "/v1/status", None, true, false),
            Err(RuntimeLauncherError::ApprovalHeaderNotAllowed)
        );
    }

    #[test]
    fn decodes_chunked_json_response() {
        let wire =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n{\"ok\":1}\r\n0\r\n\r\n";
        assert_eq!(
            decode_http_response(wire).unwrap(),
            (200, "{\"ok\":1}".into())
        );
    }

    #[test]
    fn rejects_chunked_response_over_the_body_limit() {
        let oversized = format!("{:x}", MAX_RESPONSE_BYTES + 1);
        let wire = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{oversized}\r\n{}\r\n0\r\n\r\n",
            "x".repeat(MAX_RESPONSE_BYTES + 1)
        );
        assert_eq!(
            decode_http_response(wire.as_bytes()),
            Err(RuntimeLauncherError::ResponseTooLarge)
        );
    }

    #[test]
    fn runtime_request_rejects_oversized_response() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let body = vec![b'x'; MAX_RESPONSE_BYTES + 1];
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        let result = runtime_request(
            &RuntimeReady {
                host: "127.0.0.1".into(),
                port: address.port(),
            },
            "control-token",
            "approval-token",
            "GET",
            "/v1/status",
            None,
            false,
        );
        server.join().unwrap();
        assert_eq!(result, Err(RuntimeLauncherError::ResponseTooLarge));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RuntimeLaunchSpec {
        RuntimeLaunchSpec {
            node_executable: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            runtime_script: PathBuf::from(r"C:\workbench\bin\workbench.mjs"),
            working_directory: PathBuf::from(r"C:\workbench"),
            args: vec![
                "--root".into(),
                r"C:\workbench".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "0".into(),
                "--json".into(),
            ],
            token_env: "OCW_TOKEN".into(),
            approval_token_env: "OCW_APPROVAL".into(),
            token: "secret-token".into(),
            approval_token: "secret-approval".into(),
        }
    }

    #[test]
    fn requires_absolute_paths() {
        let mut value = spec();
        value.runtime_script = PathBuf::from("bin/workbench.mjs");
        assert_eq!(
            value.validate(),
            Err(RuntimeLauncherError::RelativeRuntimeScript)
        );
    }

    #[test]
    fn rejects_empty_arguments() {
        let mut value = spec();
        value.args.push(String::new());
        assert_eq!(value.validate(), Err(RuntimeLauncherError::EmptyArgument));
    }

    #[test]
    fn rejects_tokens_in_arguments() {
        let mut value = spec();
        value.args.push(value.token.clone());
        assert_eq!(
            value.validate(),
            Err(RuntimeLauncherError::TokenInArguments)
        );
    }

    #[test]
    fn keeps_tokens_out_of_cli_arguments() {
        let value = spec();
        let args = value.cli_args();
        assert!(!args.contains(&value.token));
        assert!(!args.contains(&value.approval_token));
    }

    #[test]
    fn parses_loopback_ready_output() {
        let ready = parse_ready(r#"{"service":{"host":"127.0.0.1","port":4312}}"#).unwrap();
        assert_eq!(
            ready,
            RuntimeReady {
                host: "127.0.0.1".into(),
                port: 4312
            }
        );
    }

    #[test]
    fn rejects_non_loopback_ready_output() {
        assert_eq!(
            parse_ready(r#"{"service":{"host":"0.0.0.0","port":4312}}"#),
            Err(RuntimeLauncherError::ReadyHostInvalid)
        );
    }

    #[test]
    fn derives_existing_runtime_entrypoint() {
        assert_eq!(
            runtime_script_from(Path::new(r"C:\workbench")),
            PathBuf::from(r"C:\workbench\bin\workbench.mjs")
        );
    }
}

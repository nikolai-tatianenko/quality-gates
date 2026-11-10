// Compiled with Rust 1.95 and Tauri 2.12 (cargo check, clippy -D warnings, tauri build --bundles app on macOS).
// This file is deliberately small. It does four things and holds no project logic:
//   1. starts the Node host (host/host.mjs) that owns workspaces, the bridge, notifications and folder opening,
//   2. forwards the launcher page's requests to the host, but only for the method names in ALLOWED_METHODS,
//   3. relays every host line back to the page as the `host-message` event,
//   4. shows an OS notification for host `notify` events (the host only sends them when the person opted in).
// No shell plugin, no filesystem plugin, no opener plugin: the shell cannot run commands or open paths itself.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

/// Must equal HOST_METHODS in packages/desktop/src/host.ts (tests/desktop-package.test.ts compares the two).
const ALLOWED_METHODS: [&str; 7] = [
    "state",
    "project.prepare",
    "project.start",
    "project.stop",
    "prefs.set",
    "workspace.forget",
    "open.folder",
];
const MAX_LINE: usize = 8192;

struct Host(Mutex<ChildStdin>);

#[tauri::command]
fn host_send(line: String, host: State<Host>) -> Result<(), String> {
    if line.len() > MAX_LINE || line.contains('\n') {
        return Err("request too large".into());
    }
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|_| "invalid request")?;
    let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if !ALLOWED_METHODS.contains(&method) {
        return Err("unknown method".into());
    }
    let mut stdin = host.0.lock().map_err(|_| "host unavailable")?;
    writeln!(stdin, "{}", line).map_err(|_| "host unavailable".to_string())
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![host_send])
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("host");
            let data = app.path().app_data_dir()?;
            // Needs Node 22 on PATH in this prototype. Shipping a Node runtime is an open item (docs/DESKTOP_SIGNING.md).
            // QUALITYGATE_CLI points at a CLI that has its node_modules next to it; the bundled copy is not self-contained.
            let cli = std::env::var_os("QUALITYGATE_CLI")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| resources.join("qualitygate.mjs"));
            let mut child = Command::new("node")
                .arg(resources.join("host.mjs"))
                .arg("--cli")
                .arg(cli)
                .arg("--assets")
                .arg(resources.join("dashboard"))
                .arg("--data-dir")
                .arg(data)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?;
            let stdin = child.stdin.take().ok_or("no host stdin")?;
            let stdout = child.stdout.take().ok_or("no host stdout")?;
            app.manage(Host(Mutex::new(stdin)));
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        if value.get("event").and_then(|e| e.as_str()) == Some("notify") {
                            let title = clip(
                                value
                                    .get("title")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("QualityGate"),
                                120,
                            );
                            let body = clip(
                                value.get("body").and_then(|b| b.as_str()).unwrap_or(""),
                                240,
                            );
                            let _ = handle
                                .notification()
                                .builder()
                                .title(title)
                                .body(body)
                                .show();
                        }
                    }
                    let _ = handle.emit("host-message", line);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running QualityGate");
}

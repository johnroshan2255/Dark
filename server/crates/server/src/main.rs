use anyhow::Result;
use clap::Parser;
use dark_server::config::Config;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    // `dark-server healthcheck`: for container HEALTHCHECKs (the distroless image has no curl / shell).
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(if healthcheck().await { 0 } else { 1 });
    }
    let cfg = Config::parse();
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn"));
    if cfg.log_json() {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .flatten_event(true)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    let metrics = dark_server::metrics::install()?;
    let listener = tokio::net::TcpListener::bind(cfg.bind).await?;
    dark_server::serve(cfg, None, listener, Some(metrics), shutdown_signal()).await
}

/// SIGTERM (containers, Edgegap, Kubernetes) or Ctrl-C.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

/// GET /healthz on the local port (DARK_BIND's port, default 7350) within 2 s.
async fn healthcheck() -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port = std::env::var("DARK_BIND")
        .ok()
        .and_then(|b| b.parse::<std::net::SocketAddr>().ok())
        .map_or(7350, |a| a.port());
    let probe = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        s.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .ok()?;
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).await.ok()?;
        Some(buf[..n].starts_with(b"HTTP/1.1 200"))
    };
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), probe).await,
        Ok(Some(true))
    )
}

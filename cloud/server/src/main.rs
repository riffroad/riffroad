use opensmith_cloud_server::{AppState, Config, router};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let Some(config) = Config::from_env() else {
        eprintln!("OPENSMITH_PROJECT is not set");
        std::process::exit(2);
    };
    let port = std::env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    tracing::info!(port, project = config.project, emulators = config.firestore_emulator.is_some(), "listening");
    axum::serve(listener, router(AppState::new(&config)))
        // Cloud Run stops an instance with SIGTERM.
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        })
        .await
        .expect("serve");
}

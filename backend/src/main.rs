use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use workshop_backend::config::Config;
use workshop_backend::db;
use workshop_backend::routes::{build_router, AppState};

/// Boots the Rust/Axum workshop backend, runs SQLx migrations, and serves HTTP and WebSocket traffic.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("../.env");

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr;
    let pool = db::connect_and_migrate(&config.database_url).await?;
    let state = AppState::new(config, pool).await?;
    let app = build_router(state);

    let listener = TcpListener::bind(bind_addr).await?;
    tracing::info!("workshop-backend listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

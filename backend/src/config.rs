use std::fmt;
use std::net::SocketAddr;

/// Runtime application configuration loaded fail-fast from environment variables.
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub demo_access_token: String,
    pub facilitator_token: String,
    pub admin_token: String,
    pub demo_enabled: bool,
    pub bind_addr: SocketAddr,
    pub allowed_origins: Vec<String>,
}

impl fmt::Debug for Config {
    /// Formats configuration while redacting database URLs and access tokens.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"[REDACTED]")
            .field("demo_access_token", &"[REDACTED]")
            .field("facilitator_token", &"[REDACTED]")
            .field("admin_token", &"[REDACTED]")
            .field("demo_enabled", &self.demo_enabled)
            .field("bind_addr", &self.bind_addr)
            .field("allowed_origins", &self.allowed_origins)
            .finish()
    }
}

/// Error returned when required configuration is missing or malformed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    /// Writes the configuration error description.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Loads and validates configuration from process environment variables.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Loads configuration from a lookup closure for deterministic unit testing.
    pub fn from_lookup<F>(lookup: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let database_url = require_non_empty(&lookup, "DATABASE_URL")?;
        let demo_access_token = lookup("DEMO_ACCESS_TOKEN")
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let facilitator_token = require_non_empty(&lookup, "FACILITATOR_TOKEN")?;
        let admin_token = require_non_empty(&lookup, "ADMIN_TOKEN")?;

        let demo_enabled = match lookup("DEMO_ENABLED").map(|v| v.trim().to_ascii_lowercase()) {
            None => true,
            Some(v) if matches!(v.as_str(), "true" | "1" | "yes") => true,
            Some(v) if matches!(v.as_str(), "false" | "0" | "no") => false,
            Some(other) => {
                return Err(ConfigError(format!(
                    "invalid DEMO_ENABLED value '{other}': expected true/false"
                )));
            }
        };

        let bind_raw = lookup("BIND_ADDR")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "0.0.0.0:3001".to_string());
        let bind_addr = bind_raw
            .parse::<SocketAddr>()
            .map_err(|e| ConfigError(format!("invalid BIND_ADDR '{bind_raw}': {e}")))?;

        let allowed_origins = match lookup("ALLOWED_ORIGINS") {
            None => vec!["http://localhost:3000".to_string()],
            Some(raw) => {
                let origins: Vec<String> = raw
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if origins.is_empty() {
                    return Err(ConfigError(
                        "ALLOWED_ORIGINS cannot be empty when set".to_string(),
                    ));
                }
                origins
            }
        };

        Ok(Self {
            database_url,
            demo_access_token,
            facilitator_token,
            admin_token,
            demo_enabled,
            bind_addr,
            allowed_origins,
        })
    }
}

/// Reads a required environment variable and fails if absent or whitespace-only.
fn require_non_empty<F>(lookup: &F, name: &str) -> Result<String, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    match lookup(name) {
        Some(val) if !val.trim().is_empty() => Ok(val.trim().to_string()),
        _ => Err(ConfigError(format!(
            "missing or empty required environment variable: {name}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Builds a valid base configuration map for unit tests.
    fn base_env() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("DATABASE_URL", "postgres://user:pass@localhost:5432/db"),
            ("DEMO_ACCESS_TOKEN", "demo-secret-token"),
            ("FACILITATOR_TOKEN", "fac-secret-token"),
            ("ADMIN_TOKEN", "admin-secret-token"),
        ])
    }

    /// Verifies default values load and Debug output redacts secrets.
    #[test]
    fn loads_defaults_and_redacts_debug() {
        let env = base_env();
        let cfg = Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap();
        assert!(cfg.demo_enabled);
        assert_eq!(cfg.bind_addr, "0.0.0.0:3001".parse().unwrap());
        assert_eq!(cfg.allowed_origins, vec!["http://localhost:3000"]);

        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("demo-secret-token"));
        assert!(!dbg.contains("fac-secret-token"));
        assert!(!dbg.contains("admin-secret-token"));
        assert!(!dbg.contains("postgres://user:pass"));
        assert!(dbg.contains("[REDACTED]"));
    }

    /// Verifies missing or blank required secrets fail fast with variable name.
    #[test]
    fn fails_on_missing_or_blank_required_vars() {
        for key in ["DATABASE_URL", "FACILITATOR_TOKEN", "ADMIN_TOKEN"] {
            let mut env = base_env();
            env.remove(key);
            let err = Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap_err();
            assert!(err.0.contains(key));

            env.insert(key, "   ");
            let err_blank =
                Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap_err();
            assert!(err_blank.0.contains(key));
        }
    }

    /// Verifies DEMO_ENABLED, BIND_ADDR, and ALLOWED_ORIGINS strict parsing.
    #[test]
    fn parses_and_validates_optional_settings() {
        let mut env = base_env();
        env.insert("DEMO_ENABLED", "false");
        env.insert("BIND_ADDR", "127.0.0.1:4000");
        env.insert("ALLOWED_ORIGINS", "https://a.example, https://b.example");
        let cfg = Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap();
        assert!(!cfg.demo_enabled);
        assert_eq!(cfg.bind_addr, "127.0.0.1:4000".parse().unwrap());
        assert_eq!(
            cfg.allowed_origins,
            vec!["https://a.example", "https://b.example"]
        );

        env.insert("DEMO_ENABLED", "flase");
        assert!(Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).is_err());

        env.insert("DEMO_ENABLED", "true");
        env.insert("BIND_ADDR", "not-an-addr");
        assert!(Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).is_err());

        env.insert("BIND_ADDR", "127.0.0.1:3001");
        env.insert("ALLOWED_ORIGINS", " , ");
        assert!(Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).is_err());
    }
}

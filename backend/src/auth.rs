use axum::http::{header, HeaderMap, HeaderValue};
use sqlx::PgPool;
use subtle::ConstantTimeEq;

use crate::config::Config;

/// Cookie name storing the facilitator access token.
pub const FACILITATOR_COOKIE: &str = "facilitator_token";
/// Cookie name used by Better Auth for browser session tokens.
pub const BETTER_AUTH_COOKIE: &str = "better-auth.session_token";
/// Secure cookie name used by Better Auth over HTTPS.
pub const BETTER_AUTH_SECURE_COOKIE: &str = "__Secure-better-auth.session_token";

/// Compares two token strings in constant time without leaking length via early byte exit.
pub fn constant_time_eq(provided: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let a = provided.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Extracts a named cookie value from an HTTP HeaderMap.
pub fn extract_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for val in headers.get_all(header::COOKIE) {
        if let Ok(raw) = val.to_str() {
            for part in raw.split(';') {
                if let Some((k, v)) = part.trim().split_once('=') {
                    if k.trim() == name {
                        let clean = v.trim();
                        if !clean.is_empty() {
                            return Some(clean.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Extracts a bearer token from an Authorization header if present.
pub fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Extracts a custom header value trimmed of whitespace.
pub fn extract_header(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// Normalizes a Better Auth signed cookie value (`<token>.<signature>`) to its raw session token.
fn normalize_better_auth_token(raw: &str) -> String {
    let decoded = raw.replace("%2E", ".").replace("%2e", ".");
    decoded
        .split('.')
        .next()
        .unwrap_or(&decoded)
        .trim()
        .to_string()
}

/// Collects all candidate facilitator/Better Auth session tokens from request headers and cookies.
pub fn collect_facilitator_tokens(headers: &HeaderMap) -> Vec<String> {
    let mut out = Vec::new();
    for candidate in [
        extract_header(headers, "x-facilitator-token"),
        extract_bearer(headers),
        extract_cookie(headers, FACILITATOR_COOKIE),
        extract_cookie(headers, BETTER_AUTH_COOKIE),
        extract_cookie(headers, BETTER_AUTH_SECURE_COOKIE),
    ]
    .into_iter()
    .flatten()
    {
        let raw_part = normalize_better_auth_token(&candidate);
        if !raw_part.is_empty() && !out.contains(&raw_part) {
            out.push(raw_part);
        }
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// Checks whether request headers carry the runtime facilitator token synchronously.
pub fn has_valid_facilitator_token(headers: &HeaderMap, config: &Config) -> bool {
    collect_facilitator_tokens(headers)
        .iter()
        .any(|t| constant_time_eq(t, &config.facilitator_token))
}

/// Resolves the authenticated Better Auth user ID (or `"service_token"` for API token callers).
pub async fn resolve_facilitator_user_id(
    pool: &PgPool,
    headers: &HeaderMap,
    config: &Config,
) -> Option<String> {
    let tokens = collect_facilitator_tokens(headers);
    if tokens.is_empty() {
        return None;
    }
    if let Ok(Some(user_id)) = sqlx::query_scalar::<_, String>(
        r#"SELECT "userId" FROM "session"
           WHERE token = ANY($1) AND "expiresAt" > now()
           LIMIT 1"#,
    )
    .bind(&tokens)
    .fetch_optional(pool)
    .await
    {
        return Some(user_id);
    }
    if tokens
        .iter()
        .any(|t| constant_time_eq(t, &config.facilitator_token))
    {
        return Some("service_token".to_string());
    }
    None
}

/// Verifies whether the caller holds either a valid Better Auth session in PostgreSQL or the facilitator token.
pub async fn has_valid_facilitator_session(
    pool: &PgPool,
    headers: &HeaderMap,
    config: &Config,
) -> bool {
    resolve_facilitator_user_id(pool, headers, config)
        .await
        .is_some()
}

/// Checks whether request headers carry the owner admin token.
pub fn has_valid_admin_token(headers: &HeaderMap, config: &Config) -> bool {
    let candidates = [
        extract_header(headers, "x-admin-token"),
        extract_bearer(headers),
    ];
    candidates
        .into_iter()
        .flatten()
        .any(|t| constant_time_eq(&t, &config.admin_token))
}

/// Builds an HttpOnly SameSite=Lax Set-Cookie HeaderValue for an authenticated session token.
pub fn build_auth_cookie(name: &str, value: &str) -> HeaderValue {
    let cookie = format!("{name}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400");
    HeaderValue::from_str(&cookie).expect("valid cookie header value")
}

/// Builds an expired Set-Cookie HeaderValue to clear an authentication cookie.
pub fn clear_auth_cookie(name: &str) -> HeaderValue {
    let cookie = format!("{name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    HeaderValue::from_str(&cookie).expect("valid clear cookie header value")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Helper creating a test Config with known tokens.
    fn test_config() -> Config {
        let env = HashMap::from([
            ("DATABASE_URL", "postgres://u:p@localhost:5432/db"),
            ("FACILITATOR_TOKEN", "fac-tok-456"),
            ("ADMIN_TOKEN", "adm-tok-789"),
        ]);
        Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap()
    }

    /// Verifies constant-time token comparison and header/cookie extractors.
    #[test]
    fn verifies_tokens_across_headers_and_cookies() {
        let cfg = test_config();
        assert!(constant_time_eq("fac-tok-456", "fac-tok-456"));
        assert!(!constant_time_eq("fac-tok-456", "fac-tok-457"));
        assert!(!constant_time_eq("short", "fac-tok-456"));

        let mut headers = HeaderMap::new();
        assert!(!has_valid_facilitator_token(&headers, &cfg));

        headers.insert(
            header::COOKIE,
            HeaderValue::from_static(
                "better-auth.session_token=ba_tok_123.sig_abc; facilitator_token=fac-tok-456",
            ),
        );
        assert!(has_valid_facilitator_token(&headers, &cfg));
        let extracted = collect_facilitator_tokens(&headers);
        assert!(extracted.contains(&"ba_tok_123".to_string()));

        let mut admin_headers = HeaderMap::new();
        admin_headers.insert("x-admin-token", HeaderValue::from_static("adm-tok-789"));
        assert!(has_valid_admin_token(&admin_headers, &cfg));
    }
}

use crate::{AuthError, AuthenticatedUser, ConnectionScope, Credential, Principal, Result};
use jsonwebtoken::jwk::{Jwk, JwkSet, KeyOperations, PublicKeyUse};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{Map, Value};

/// OIDC bearer-token provider backed by a caller-managed JWKS cache.
#[derive(Debug, Clone)]
pub struct OidcProvider {
    config: OidcProviderConfig,
    jwks: JwkSet,
}

impl OidcProvider {
    /// Creates an OIDC provider from a JWKS JSON document.
    ///
    /// Tokens without a `kid` header are accepted only when exactly one JWKS
    /// key matches the token algorithm. A no-`kid` token with multiple
    /// matching candidate keys is rejected as ambiguous.
    pub fn from_jwks_json(config: OidcProviderConfig, jwks_json: &str) -> Result<Self> {
        let jwks = serde_json::from_str::<JwkSet>(jwks_json)
            .map_err(|error| AuthError::InvalidOidcJwks(error.to_string()))?;
        if jwks.keys.is_empty() {
            return Err(AuthError::InvalidOidcJwks(
                "JWKS must contain at least one key".to_owned(),
            ));
        }

        Ok(Self { config, jwks })
    }

    /// Returns the provider configuration.
    pub fn config(&self) -> &OidcProviderConfig {
        &self.config
    }

    /// Authenticates a bearer JWT.
    #[allow(clippy::manual_async_fn)]
    pub fn authenticate(
        &self,
        presented: Credential,
    ) -> impl std::future::Future<Output = Result<AuthenticatedUser>> + Send + '_ {
        async move {
            match presented {
                Credential::BearerToken(token) => self.authenticate_bearer(&token),
                _ => Err(AuthError::InvalidCredential(
                    "OIDC provider requires a bearer token",
                )),
            }
        }
    }

    fn authenticate_bearer(&self, token: &str) -> Result<AuthenticatedUser> {
        let header = decode_header(token)
            .map_err(|error| AuthError::OidcTokenRejected(error.to_string()))?;
        if !self.config.allowed_algorithms.contains(&header.alg) {
            return Err(AuthError::OidcAlgorithmNotAllowed {
                algorithm: format!("{:?}", header.alg),
            });
        }

        let jwk = self.select_jwk(header.kid.as_deref(), header.alg)?;
        let decoding_key = DecodingKey::from_jwk(jwk)
            .map_err(|error| AuthError::OidcTokenRejected(error.to_string()))?;
        let claims = decode::<OidcClaims>(token, &decoding_key, &self.validation(header.alg))
            .map_err(|error| AuthError::OidcTokenRejected(error.to_string()))?
            .claims;

        let principal = self.config.principal_for_subject(&claims.sub)?;
        let scope = self.config.scope_for_claims(&claims.extra);

        Ok(AuthenticatedUser::with_allowed_operator_kinds(
            principal,
            scope,
            self.config.allowed_operator_kinds.clone(),
        ))
    }

    fn select_jwk(&self, kid: Option<&str>, algorithm: Algorithm) -> Result<&Jwk> {
        if let Some(kid) = kid {
            let jwk = self
                .jwks
                .find(kid)
                .ok_or_else(|| AuthError::OidcKeyNotFound {
                    kid: Some(kid.to_owned()),
                })?;
            self.validate_jwk_algorithm(jwk, algorithm)?;
            return Ok(jwk);
        }

        let mut candidates = self
            .jwks
            .keys
            .iter()
            .filter(|jwk| self.validate_jwk_algorithm(jwk, algorithm).is_ok());

        let Some(jwk) = candidates.next() else {
            return Err(AuthError::OidcKeyNotFound { kid: None });
        };
        if candidates.next().is_some() {
            return Err(AuthError::OidcKeyNotFound { kid: None });
        }

        Ok(jwk)
    }

    fn validate_jwk_algorithm(&self, jwk: &Jwk, algorithm: Algorithm) -> Result<()> {
        if matches!(jwk.common.public_key_use, Some(PublicKeyUse::Encryption)) {
            return Err(AuthError::OidcTokenRejected(
                "JWK is not marked for signature verification".to_owned(),
            ));
        }
        if let Some(key_operations) = &jwk.common.key_operations {
            let has_verify = key_operations
                .iter()
                .any(|operation| matches!(operation, KeyOperations::Verify));
            if !has_verify {
                return Err(AuthError::OidcTokenRejected(
                    "JWK is not allowed to verify signatures".to_owned(),
                ));
            }
        }
        if let Some(key_algorithm) = jwk.common.key_algorithm {
            let key_algorithm = format!("{key_algorithm}");
            if key_algorithm != format!("{algorithm:?}") {
                return Err(AuthError::OidcAlgorithmNotAllowed {
                    algorithm: format!("{algorithm:?}"),
                });
            }
        }
        Ok(())
    }

    fn validation(&self, algorithm: Algorithm) -> Validation {
        let mut validation = Validation::new(algorithm);
        validation.set_issuer(&[self.config.issuer.as_str()]);
        validation.set_audience(&[self.config.audience.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = self.config.leeway_seconds;
        validation
    }
}

/// OIDC provider configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcProviderConfig {
    issuer: String,
    audience: String,
    principal_namespace: String,
    default_scope: ConnectionScope,
    allowed_algorithms: Vec<Algorithm>,
    leeway_seconds: u64,
    scope_claim_names: Vec<String>,
    scope_mappings: Vec<OidcScopeMapping>,
    allowed_operator_kinds: Vec<String>,
}

impl OidcProviderConfig {
    /// Creates a config for a single issuer/audience pair.
    ///
    /// `principal_namespace` is prepended to the token subject with a colon,
    /// for example `user:anaconda` + `550e` becomes `user:anaconda:550e`.
    pub fn new(
        issuer: impl Into<String>,
        audience: impl Into<String>,
        principal_namespace: impl Into<String>,
    ) -> Result<Self> {
        let issuer = issuer.into();
        let audience = audience.into();
        let principal_namespace = principal_namespace.into();

        if issuer.is_empty() {
            return Err(AuthError::InvalidOidcConfig("issuer cannot be empty"));
        }
        if audience.is_empty() {
            return Err(AuthError::InvalidOidcConfig("audience cannot be empty"));
        }
        if principal_namespace.is_empty() {
            return Err(AuthError::InvalidOidcConfig(
                "principal namespace cannot be empty",
            ));
        }
        let namespace = Principal::new(principal_namespace.clone())?;
        if namespace.as_str() == Principal::SYSTEM {
            return Err(AuthError::InvalidOidcConfig(
                "principal namespace cannot be system",
            ));
        }

        Ok(Self {
            issuer,
            audience,
            principal_namespace,
            default_scope: ConnectionScope::Viewer,
            allowed_algorithms: vec![Algorithm::RS256],
            leeway_seconds: 60,
            scope_claim_names: vec!["scope".to_owned(), "scp".to_owned()],
            scope_mappings: Vec::new(),
            allowed_operator_kinds: Vec::new(),
        })
    }

    /// Expected issuer claim.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// Expected audience claim.
    pub fn audience(&self) -> &str {
        &self.audience
    }

    /// Principal namespace used for authenticated subjects.
    pub fn principal_namespace(&self) -> &str {
        &self.principal_namespace
    }

    /// Scope assigned when no configured mapping matches token claims.
    pub const fn default_scope(&self) -> ConnectionScope {
        self.default_scope
    }

    /// Allows a different default scope.
    pub fn with_default_scope(mut self, default_scope: ConnectionScope) -> Self {
        self.default_scope = default_scope;
        self
    }

    /// Allows a custom algorithm allow-list.
    pub fn with_allowed_algorithms(mut self, allowed_algorithms: Vec<Algorithm>) -> Result<Self> {
        if allowed_algorithms.is_empty() {
            return Err(AuthError::InvalidOidcConfig(
                "allowed algorithms cannot be empty",
            ));
        }
        if allowed_algorithms
            .iter()
            .any(|algorithm| !is_asymmetric_algorithm(*algorithm))
        {
            return Err(AuthError::InvalidOidcConfig(
                "OIDC bearer validation requires asymmetric algorithms",
            ));
        }
        self.allowed_algorithms = allowed_algorithms;
        Ok(self)
    }

    /// Allows a custom expiration/not-before clock-skew allowance in seconds.
    pub const fn with_leeway_seconds(mut self, leeway_seconds: u64) -> Self {
        self.leeway_seconds = leeway_seconds;
        self
    }

    /// Replaces the claim names used to read provider scopes.
    pub fn with_scope_claim_names(mut self, scope_claim_names: Vec<String>) -> Result<Self> {
        if scope_claim_names.is_empty() {
            return Err(AuthError::InvalidOidcConfig(
                "scope claim names cannot be empty",
            ));
        }
        if scope_claim_names.iter().any(|claim| claim.is_empty()) {
            return Err(AuthError::InvalidOidcConfig(
                "scope claim names cannot contain empty values",
            ));
        }
        self.scope_claim_names = scope_claim_names;
        Ok(self)
    }

    /// Adds a provider-scope to connection-scope mapping.
    ///
    /// Mappings are evaluated in insertion order. This avoids pretending the
    /// room scopes form a total order when `editor` and `runtime_peer` are
    /// intentionally different capabilities.
    pub fn map_scope(mut self, claim_value: impl Into<String>, scope: ConnectionScope) -> Self {
        self.scope_mappings.push(OidcScopeMapping {
            claim_value: claim_value.into(),
            scope,
        });
        self
    }

    /// Restricts operator kinds accepted for authenticated connections.
    pub fn with_allowed_operator_kinds(mut self, allowed_operator_kinds: Vec<String>) -> Self {
        self.allowed_operator_kinds = allowed_operator_kinds;
        self
    }

    fn principal_for_subject(&self, subject: &str) -> Result<Principal> {
        if subject.is_empty() {
            return Err(AuthError::OidcTokenRejected(
                "subject cannot be empty".to_owned(),
            ));
        }
        Principal::new(format!(
            "{}:{}",
            self.principal_namespace,
            encode_principal_component(subject)
        ))
    }

    fn scope_for_claims(&self, extra: &Map<String, Value>) -> ConnectionScope {
        let values = self.claim_values(extra);
        for mapping in &self.scope_mappings {
            if values.iter().any(|value| value == &mapping.claim_value) {
                return mapping.scope;
            }
        }
        self.default_scope
    }

    fn claim_values(&self, extra: &Map<String, Value>) -> Vec<String> {
        let mut values = Vec::new();
        for claim_name in &self.scope_claim_names {
            if let Some(value) = extra.get(claim_name) {
                collect_scope_claim_values(value, &mut values);
            }
        }
        values
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OidcScopeMapping {
    claim_value: String,
    scope: ConnectionScope,
}

#[derive(Debug, Deserialize)]
struct OidcClaims {
    sub: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn collect_scope_claim_values(value: &Value, values: &mut Vec<String>) {
    match value {
        Value::String(scope) => {
            values.extend(scope.split_whitespace().map(ToOwned::to_owned));
        }
        Value::Array(scopes) => {
            for scope in scopes {
                if let Value::String(scope) = scope {
                    values.push(scope.to_owned());
                }
            }
        }
        _ => {}
    }
}

fn encode_principal_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if is_principal_component_byte(byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

const fn is_principal_component_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b':' | b'@'
    )
}

const fn is_asymmetric_algorithm(algorithm: Algorithm) -> bool {
    matches!(
        algorithm,
        Algorithm::RS256
            | Algorithm::RS384
            | Algorithm::RS512
            | Algorithm::PS256
            | Algorithm::PS384
            | Algorithm::PS512
            | Algorithm::ES256
            | Algorithm::ES384
            | Algorithm::EdDSA
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    const ISSUER: &str = "https://issuer.example.com";
    const AUDIENCE: &str = "nteract-web";
    const PRIVATE_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDLElP+KJGndkuQ
G22TX+Ep3YPUiiLmrQbsilIhXHXvtl4kBGkAqMnj8eFLR/4cR3MqcyJ3u6ms/xDq
rgsKgDObUim7cUnRLmJ9l519SFcATX7CQ09VeXluvekf8CornpBRZzRD2hsVCtmO
YRyvQ03s0Ic/jvEW31Colhtglh1ATUJIHl75dfvgru2rP26RckQayF1JfdqYdfXQ
XF9jWQtrVIfaUzW2phi4YzzQT1zz8z0LzsY9FbBYMplPSfuoRv6/wsh7DLUZDBO3
qjxq9iDnexhz8ttQjkw//4/vhM8oQqjH95soFD2KbUNuU3Y6Zuye9tbsFTJPEc5t
kmaidZgLAgMBAAECggEAAxopaKa5AZG9Ohsufi5cSQtGbMmcGoxbyzhFD0Jo1iZ3
OLNNNq0ywbCGbGPR/h+Z+Eo1pWubU3ZlYphnDcbYmE+rLd8KAs/jwZ8T0P/5EvBG
y/PtndTTEJMxIQObuU/c94liky4dSiHWIfvaItPzOEy/4YOEVlZHVqlNthjaTeBO
oZtWyxEVsH0XHCAdIginv9sILy5/UCTjFdTkCUVaAc9pkP752iI0kztsynmGNtEn
3xa9VvQ8o4RlyiARB2zC2uBBo3cliHVtz3Gl4bQpIUAO8wUpnpy9KDzFeT3CEJoo
jUFrYiI4joPUzmhQaZ7XC6XQOmIszr3TQfrviQWKNQKBgQDsJ2jgTgyIVLbEJGKS
l+4fgeLrILUWoz3rxz8O30KH7ivRnhr9hPDszbx9VowTHG9E+Je8xGBi5qirUc79
GJjDmvin08a/bMHNZvIj2Fk6R+A+necy7FFtzfUHMWLXs/L0QE2/KSK+z2lm9Vq3
Wza70wbkdSDRjtV9tOz1ohvCjQKBgQDcIzA27T5iptTveFDW0qk7hbtfcD/A2nJo
i/Rkt7nLFiyqBxDAoCf4iVtaSToOY6F0U37dZhCmRwpXYEK+QSYKe5JhgJbjvzjG
iiKDMhMexdOmohEeoDxqnmGL7409jWX0WXleTg5tBtv5j72ukPbUELbqMHLGB7Z/
kH6HNzjq9wKBgDLWGQGQS6pdciqvGnksM5qcv1iWZeVFpuLGtZBiB1RztQMe4fiJ
UcPoVhc1Nlo22M0kJqYAMC+aL90Rc1mQnfIdvkGCmVpD80RgUOfefvbI2kEghNC1
hqH4oDK4Mur0Vey2mwX3uP8Sb0I2txyZiiLMvsMXY8U41kSFWi1WhFtRAoGAQVh4
sXVPNX2Ma+FtLbeu4Kpb6oKpihfOKlaRH2yiTDSy4W3jfSqNcutjILPn9emBPcSj
PhlUC+e+nB1I8qzoG+h+lU7Ue5qBwf2zLPqqTlIu96HYLx0lkgidsCpV5NWaVCRT
MLk+8wI8PiJ7DdyeSGkFwxLKnxofBFLiHEU6MhUCgYAfLmbG0JtayVRo0oU0NJqC
WoI9aFRX2MxbVecKHip8yRVx+Ja7ycbGZ3BfOGyRsRT52dAnqG1Qq6F8BUCPsJGz
Yg2nk7XSKd0ChUB6lyP6WzNYxDyboMZ8RoDeyY/JvvC147djuRHZMIEygCLYkImt
iK6jkmv5/uDc/iFj+DniQQ==
-----END PRIVATE KEY-----"#;
    const JWK_N: &str = "yxJT_iiRp3ZLkBttk1_hKd2D1Ioi5q0G7IpSIVx177ZeJARpAKjJ4_HhS0f-HEdzKnMid7uprP8Q6q4LCoAzm1Ipu3FJ0S5ifZedfUhXAE1-wkNPVXl5br3pH_AqK56QUWc0Q9obFQrZjmEcr0NN7NCHP47xFt9QqJYbYJYdQE1CSB5e-XX74K7tqz9ukXJEGshdSX3amHX10FxfY1kLa1SH2lM1tqYYuGM80E9c8_M9C87GPRWwWDKZT0n7qEb-v8LIewy1GQwTt6o8avYg53sYc_LbUI5MP_-P74TPKEKox_ebKBQ9im1DblN2OmbsnvbW7BUyTxHObZJmonWYCw";

    fn jwks_json() -> String {
        jwks_json_with_extra("")
    }

    fn jwks_json_with_extra(extra: &str) -> String {
        format!(
            r#"{{"keys":[{{"kty":"RSA","kid":"test-key","alg":"RS256"{extra},"n":"{JWK_N}","e":"AQAB"}}]}}"#
        )
    }

    fn config() -> OidcProviderConfig {
        match OidcProviderConfig::new(ISSUER, AUDIENCE, "user:anaconda") {
            Ok(config) => config
                .map_scope("notebook:owner", ConnectionScope::Owner)
                .map_scope("notebook:edit", ConnectionScope::Editor)
                .map_scope("notebook:runtime", ConnectionScope::RuntimePeer)
                .map_scope("notebook:read", ConnectionScope::Viewer)
                .with_allowed_operator_kinds(vec!["desktop".to_owned(), "agent".to_owned()]),
            Err(error) => panic!("OIDC config should construct: {error}"),
        }
    }

    fn provider(config: OidcProviderConfig) -> OidcProvider {
        match OidcProvider::from_jwks_json(config, &jwks_json()) {
            Ok(provider) => provider,
            Err(error) => panic!("OIDC provider should construct: {error}"),
        }
    }

    fn token(mut claims: Value, kid: Option<&str>) -> String {
        let Some(claims_object) = claims.as_object_mut() else {
            panic!("claims fixture should be an object");
        };
        claims_object.insert(
            "exp".to_owned(),
            Value::from(jsonwebtoken::get_current_timestamp() + 3600),
        );

        let mut header = Header::new(Algorithm::RS256);
        header.kid = kid.map(ToOwned::to_owned);
        let key = match EncodingKey::from_rsa_pem(PRIVATE_KEY.as_bytes()) {
            Ok(key) => key,
            Err(error) => panic!("fixture private key should parse: {error}"),
        };

        match encode(&header, &claims, &key) {
            Ok(token) => token,
            Err(error) => panic!("fixture token should encode: {error}"),
        }
    }

    fn valid_claims() -> Value {
        json!({
            "sub": "550e8400-e29b-41d4-a716-446655440000",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "scope": "notebook:edit notebook:owner"
        })
    }

    fn authenticate(provider: &OidcProvider, token: String) -> Result<AuthenticatedUser> {
        block_on(provider.authenticate(Credential::BearerToken(token)))
    }

    #[test]
    fn accepts_valid_rs256_bearer_token() {
        let provider = provider(config());
        let user = match authenticate(&provider, token(valid_claims(), Some("test-key"))) {
            Ok(user) => user,
            Err(error) => panic!("valid OIDC token should authenticate: {error}"),
        };

        assert_eq!(
            user.principal().as_str(),
            "user:anaconda:550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(user.scope(), ConnectionScope::Owner);
        assert_eq!(
            user.allowed_operator_kinds(),
            &["desktop".to_owned(), "agent".to_owned()]
        );
    }

    #[test]
    fn uses_configured_scope_claim_arrays() {
        let provider = provider(config());
        let claims = json!({
            "sub": "runtime-peer",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "scp": ["notebook:runtime"]
        });
        let user = match authenticate(&provider, token(claims, Some("test-key"))) {
            Ok(user) => user,
            Err(error) => panic!("valid OIDC token should authenticate: {error}"),
        };

        assert_eq!(user.scope(), ConnectionScope::RuntimePeer);
    }

    #[test]
    fn falls_back_to_default_scope_without_mapping() {
        let provider = provider(config().with_default_scope(ConnectionScope::Viewer));
        let claims = json!({
            "sub": "viewer",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "scope": "profile email"
        });
        let user = match authenticate(&provider, token(claims, Some("test-key"))) {
            Ok(user) => user,
            Err(error) => panic!("valid OIDC token should authenticate: {error}"),
        };

        assert_eq!(user.scope(), ConnectionScope::Viewer);
    }

    #[test]
    fn percent_encodes_subject_slashes_for_principal() {
        let provider = provider(config());
        let claims = json!({
            "sub": "team/alice%admin/é",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "scope": "notebook:edit"
        });
        let user = match authenticate(&provider, token(claims, Some("test-key"))) {
            Ok(user) => user,
            Err(error) => panic!("valid OIDC token should authenticate: {error}"),
        };

        assert_eq!(
            user.principal().as_str(),
            "user:anaconda:team%2Falice%25admin%2F%C3%A9"
        );
    }

    #[test]
    fn rejects_wrong_audience() {
        let provider = provider(config());
        let claims = json!({
            "sub": "alice",
            "iss": ISSUER,
            "aud": "other-audience",
            "scope": "notebook:edit"
        });
        let result = authenticate(&provider, token(claims, Some("test-key")));

        assert!(matches!(result, Err(AuthError::OidcTokenRejected(_))));
    }

    #[test]
    fn rejects_unknown_key_id() {
        let provider = provider(config());
        let result = authenticate(&provider, token(valid_claims(), Some("missing-key")));

        assert_eq!(
            result,
            Err(AuthError::OidcKeyNotFound {
                kid: Some("missing-key".to_owned())
            })
        );
    }

    #[test]
    fn rejects_encryption_jwks() {
        let provider = match OidcProvider::from_jwks_json(
            config(),
            &jwks_json_with_extra(r#","use":"enc""#),
        ) {
            Ok(provider) => provider,
            Err(error) => panic!("OIDC provider should construct: {error}"),
        };
        let result = authenticate(&provider, token(valid_claims(), Some("test-key")));

        assert_eq!(
            result,
            Err(AuthError::OidcTokenRejected(
                "JWK is not marked for signature verification".to_owned()
            ))
        );
    }

    #[test]
    fn rejects_jwks_without_verify_operation() {
        let provider = match OidcProvider::from_jwks_json(
            config(),
            &jwks_json_with_extra(r#","key_ops":["sign"]"#),
        ) {
            Ok(provider) => provider,
            Err(error) => panic!("OIDC provider should construct: {error}"),
        };
        let result = authenticate(&provider, token(valid_claims(), Some("test-key")));

        assert_eq!(
            result,
            Err(AuthError::OidcTokenRejected(
                "JWK is not allowed to verify signatures".to_owned()
            ))
        );
    }

    #[test]
    fn rejects_non_bearer_credentials() {
        let provider = provider(config());
        let result = block_on(provider.authenticate(Credential::Cookie("cookie".to_owned())));

        assert_eq!(
            result,
            Err(AuthError::InvalidCredential(
                "OIDC provider requires a bearer token"
            ))
        );
    }

    #[test]
    fn rejects_symmetric_algorithm_configuration() {
        let result = config().with_allowed_algorithms(vec![Algorithm::HS256]);

        assert_eq!(
            result,
            Err(AuthError::InvalidOidcConfig(
                "OIDC bearer validation requires asymmetric algorithms"
            ))
        );
    }

    #[test]
    fn rejects_invalid_principal_namespaces() {
        for namespace in ["user:", "system", "bad/namespace"] {
            assert!(
                OidcProviderConfig::new(ISSUER, AUDIENCE, namespace).is_err(),
                "{namespace}"
            );
        }
    }

    #[test]
    fn rejects_empty_jwks() {
        let result = OidcProvider::from_jwks_json(config(), r#"{"keys":[]}"#);

        assert!(matches!(
            result,
            Err(AuthError::InvalidOidcJwks(message))
                if message == "JWKS must contain at least one key"
        ));
    }
}

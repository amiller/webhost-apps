//! attest-verify <model> — verify a NEAR AI Cloud model's TEE attestation with
//! bitrouter-attestation and print the attested ECIES signing pubkey as JSON.
//! Exit 0 iff verified. The e2ee client (near_e2ee.ts) refuses to encrypt
//! without this — no TOFU (webhost-apps#105).
//!
//! Env: NEAR_BASE (default https://cloud-api.near.ai/v1),
//!      NEAR_API_KEY (required since NEAR added auth to the report endpoint —
//!      sent as Bearer on the report fetch),
//!      NEAR_KMS_ROOTS, NEAR_BASE_MEASUREMENTS, NEAR_IMAGE_DIGESTS and/or
//!      NEAR_WORKLOAD_IDS (pins; required — the policy refuses to run unpinned),
//!      NVIDIA_EAT_KEY_PEM (optional; default fetches NVIDIA's JWKS).

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bitrouter_attestation::{
    AciDcapVerifierPolicy, AttestationReport, ConfidentialVerifier, DcapQuoteVerifier,
    NVIDIA_NRAS_JWKS_URL, NearVerifier, NvidiaEatKey, ReportTransport, SIGNING_ALGO, VerifyError,
};
use sha3::{Digest, Keccak256};

type Error = Box<dyn std::error::Error + Send + Sync>;

fn env_list(key: &str) -> Vec<String> {
    std::env::var(key)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// ReqwestTransport, but keeps the raw report JSON: the crate's
/// `AttestationReport` drops `signing_public_key`, which is the field the
/// ECIES client encrypts to. Capturing the same bytes the verifier saw lets us
/// bind pubkey -> signing_address -> report_data -> quote.
struct CapturingTransport {
    base: String,
    http: reqwest::Client,
    auth: Option<String>,
    last: Mutex<Option<serde_json::Value>>,
}

impl CapturingTransport {
    fn new(base: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            // NEAR 401s the report endpoint without a Bearer key (observed
            // 2026-08-16); the box passes its NEAR_API_KEY through the env.
            auth: std::env::var("NEAR_API_KEY").ok().filter(|k| !k.trim().is_empty()),
            last: Mutex::new(None),
        }
    }
}

#[async_trait]
impl ReportTransport for CapturingTransport {
    async fn fetch_report(&self, model: &str, nonce: &str) -> Result<AttestationReport, VerifyError> {
        let mut req = self
            .http
            .get(format!("{}/attestation/report", self.base))
            .query(&[("model", model), ("signing_algo", SIGNING_ALGO), ("nonce", nonce)]);
        if let Some(key) = &self.auth {
            req = req.bearer_auth(key);
        }
        let resp = req
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| VerifyError::Transport { what: "attestation report", source: Box::new(e) })?;
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| VerifyError::Malformed { what: "attestation report", detail: e.to_string() })?;
        *self.last.lock().unwrap() = Some(v.clone());
        serde_json::from_value(v)
            .map_err(|e| VerifyError::Malformed { what: "attestation report", detail: e.to_string() })
    }
}

fn eth_address(pubkey_hex: &str) -> Option<String> {
    let b = hex::decode(pubkey_hex).ok()?;
    let uncompressed = match b.len() {
        64 => b,
        65 if b[0] == 4 => b[1..].to_vec(),
        _ => return None,
    };
    let digest = Keccak256::digest(&uncompressed);
    Some(format!("0x{}", hex::encode(&digest[12..])))
}

/// One-time pin bootstrap: fetch a live report, verify the DCAP quote chain
/// (signature-valid, but identity NOT policy-checked — that's what the pins
/// are for), and print the observed identity values to paste into the env.
/// Review these out-of-band before trusting them.
async fn derive_pins(transport: &CapturingTransport, model: &str) -> Result<(), Error> {
    use bitrouter_attestation::{PHALA_PCCS_URL, model_identity, verify_tdx_quote};
    let nonce = fresh_nonce();
    let report = transport.fetch_report(model, &nonce).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    for m in report.model_attestations.iter().filter(|m| m.model_name == model) {
        let id = model_identity(&m.info)?;
        let quote = hex::decode(&m.intel_quote)?;
        let meas = verify_tdx_quote(&quote, PHALA_PCCS_URL, now).await?;
        let base_bundle = [meas.mr_td, meas.rtmr0, meas.rtmr1, meas.rtmr2].concat();
        println!("NEAR_WORKLOAD_IDS={}", id.workload_id);
        println!("NEAR_IMAGE_DIGESTS={}", id.image_digests.join(","));
        println!("NEAR_KMS_ROOTS={}", id.kms_root_public_key);
        println!("NEAR_BASE_MEASUREMENTS={}", hex::encode(base_bundle));
        println!("# tcb_status={:?}", meas.tcb_status);
        return Ok(());
    }
    Err(format!("no attestation for model {model}").into())
}

fn fresh_nonce() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rng().fill_bytes(&mut b);
    hex::encode(b)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let derive = args.iter().position(|a| a == "--derive-pins").map(|i| args.remove(i)).is_some();
    let model = args.into_iter().next().ok_or("usage: attest-verify [--derive-pins] <model>")?;
    let base = std::env::var("NEAR_BASE").unwrap_or_else(|_| "https://cloud-api.near.ai/v1".into());

    if derive {
        let transport = CapturingTransport::new(&base);
        return derive_pins(&transport, &model).await;
    }

    let policy = AciDcapVerifierPolicy::new(
        env_list("NEAR_WORKLOAD_IDS"),
        env_list("NEAR_IMAGE_DIGESTS"),
        env_list("NEAR_KMS_ROOTS"),
        env_list("NEAR_BASE_MEASUREMENTS"),
    )?;
    let nvidia_key = match std::env::var("NVIDIA_EAT_KEY_PEM") {
        Ok(path) => NvidiaEatKey::from_ec_pem(&std::fs::read(path)?)?,
        Err(_) => NvidiaEatKey::fetch_jwks(NVIDIA_NRAS_JWKS_URL).await?,
    };
    let transport = Arc::new(CapturingTransport::new(&base));
    let verifier = NearVerifier::new(
        transport.clone(),
        Arc::new(DcapQuoteVerifier::default()),
        Arc::new(policy),
        Arc::new(nvidia_key),
    );

    let nonce = fresh_nonce();
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let verdict = verifier.verify_attestation(&model, &nonce, now).await?;

    // The attested pubkey: its keccak address must be one the verdict attested
    // (report_data binds the address; the address commits to the pubkey).
    let raw = transport.last.lock().unwrap().take().ok_or("no report captured")?;
    let mut signing_public_key = None;
    if verdict.verified {
        for m in raw["model_attestations"].as_array().into_iter().flatten() {
            let (Some(name), Some(addr), Some(pk)) = (
                m["model_name"].as_str(),
                m["signing_address"].as_str(),
                m["signing_public_key"].as_str(),
            ) else { continue };
            if name != model || !verdict.attested_addresses.iter().any(|a| a.eq_ignore_ascii_case(addr)) {
                continue;
            }
            if eth_address(pk).is_some_and(|d| d.eq_ignore_ascii_case(addr)) {
                signing_public_key = Some(pk.to_string());
                break;
            }
        }
    }

    let ok = verdict.verified && signing_public_key.is_some();
    println!(
        "{}",
        serde_json::json!({
            "verified": ok,
            "model": verdict.model,
            "signing_public_key": signing_public_key,
            "attested_addresses": verdict.attested_addresses,
            "checks": serde_json::to_value(&verdict.checks)?,
            "nonce": verdict.nonce,
            "verified_at_unix": verdict.verified_at_unix,
        })
    );
    std::process::exit(if ok { 0 } else { 1 });
}

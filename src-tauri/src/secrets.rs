//! Secret env values, sealed with AES-256-GCM under a key kept in the OS credential store
//! (macOS Keychain, Windows Credential Manager). The key is only read when a secret is saved or a
//! service that uses one starts. Stored form: `v1:<base64(nonce | ciphertext)>`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use stackconsole_engine::secrets::SecretStore;
use std::sync::Mutex;

const SERVICE: &str = "com.stack.console";
const ACCOUNT: &str = "secret-key-v1";

pub struct KeychainSecrets {
    key: Mutex<Option<[u8; 32]>>,
}

impl KeychainSecrets {
    pub fn new() -> Self {
        KeychainSecrets { key: Mutex::new(None) }
    }

    fn key(&self) -> Option<[u8; 32]> {
        let mut cached = self.key.lock().ok()?;
        if let Some(k) = *cached {
            return Some(k);
        }
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
        let key = match entry.get_password() {
            Ok(b64) => {
                let bytes = B64.decode(b64).ok()?;
                <[u8; 32]>::try_from(bytes.as_slice()).ok()?
            }
            Err(keyring::Error::NoEntry) => {
                let mut k = [0u8; 32];
                getrandom::getrandom(&mut k).ok()?;
                entry.set_password(&B64.encode(k)).ok()?;
                k
            }
            Err(_) => return None,
        };
        *cached = Some(key);
        Some(key)
    }
}

impl SecretStore for KeychainSecrets {
    fn available(&self) -> bool {
        // Checked without touching the credential store, so start-up never prompts
        cfg!(any(target_os = "macos", target_os = "windows"))
    }

    fn encrypt(&self, plain: &str) -> Option<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.key()?).ok()?;
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce).ok()?;
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).ok()?;
        let mut out = nonce.to_vec();
        out.extend(ct);
        Some(format!("v1:{}", B64.encode(out)))
    }

    fn decrypt(&self, sealed: &str) -> Option<String> {
        // Values sealed by the Electron app (safeStorage) have no "v1:" prefix and can't be read
        let data = B64.decode(sealed.strip_prefix("v1:")?).ok()?;
        if data.len() < 13 {
            return None;
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key()?).ok()?;
        let plain = cipher.decrypt(Nonce::from_slice(&data[..12]), &data[12..]).ok()?;
        String::from_utf8(plain).ok()
    }
}

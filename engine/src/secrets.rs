//! Where secret env values are sealed. The app supplies the real store (OS keychain / DPAPI);
//! the engine only calls it at save time (encrypt) and spawn time (decrypt).

pub trait SecretStore: Send + Sync {
    /// False when the OS offers no encryption; secrets are then kept as plain text (the interface warns).
    fn available(&self) -> bool;
    fn encrypt(&self, plain: &str) -> Option<String>;
    fn decrypt(&self, sealed: &str) -> Option<String>;
}

/// No encryption available: values are stored as given, sealed values can't be read.
pub struct PlainSecrets;

impl SecretStore for PlainSecrets {
    fn available(&self) -> bool {
        false
    }
    fn encrypt(&self, _plain: &str) -> Option<String> {
        None
    }
    fn decrypt(&self, _sealed: &str) -> Option<String> {
        None
    }
}

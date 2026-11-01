//! Requests per player and per minute (a fixed window each): enough for a game that saves a
//! few times an hour, too few to flood the server. In memory: the service runs one or two
//! instances at most.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
/// Players tracked before the old windows are swept.
const SWEEP_ABOVE: usize = 10_000;

pub struct Limiter {
    per_minute: u32,
    windows: Mutex<HashMap<String, (Instant, u32)>>,
}

impl Limiter {
    pub fn new(per_minute: u32) -> Self {
        Self { per_minute, windows: Mutex::new(HashMap::new()) }
    }

    /// Whether `key` may make one more request now.
    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        if windows.len() > SWEEP_ABOVE {
            windows.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        }
        let entry = windows.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= WINDOW {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.per_minute
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_each_player_apart() {
        let l = Limiter::new(3);
        assert!((0..3).all(|_| l.allow("a")));
        assert!(!l.allow("a"));
        assert!(l.allow("b"));
    }
}

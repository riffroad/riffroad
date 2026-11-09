//! Evidence after an attack. A pitch at the start alone never proves a held note or gesture.
use crate::chart::Techniques;

#[derive(Clone, Debug)]
pub(crate) struct Performance {
    pub attack: f64,
    pub until: f64,
    pub error: f64,
    base: Option<f64>,
    techniques: Techniques,
    target: Option<f64>,
    duration: f64,
    covered: f64,
    last: Option<f64>,
    pitches: Vec<(f64, f64)>,
    peak_db: f32,
    tail_db: f32,
    last_pitch_time: f64,
    last_level_time: f64,
    contrary_pitch: bool,
    pub spectral_after: f64,
}

impl Performance {
    pub fn new(attack: f64, duration: f64, error: f64, base: Option<f64>, target: Option<f64>, techniques: Techniques) -> Self {
        Self { attack, until: attack + duration, error, base, target, techniques, duration, covered: 0.0,
            last: None, pitches: Vec::new(), peak_db: -120.0, tail_db: -120.0, last_pitch_time: -1.0, last_level_time: -1.0, contrary_pitch: false, spectral_after: attack }
    }

    pub fn pitch(&mut self, time: f64, pitch: f64) {
        let t = time - self.attack;
        if t < 0.015 || t > self.duration || t <= self.last_pitch_time || !pitch.is_finite() { return; }
        self.last_pitch_time = t;
        let Some(base) = self.base else { return };
        let target = self.target.unwrap_or(0.0);
        let off = pitch - base;
        let in_range = off >= target.min(0.0) - 0.6 && off <= target.max(0.0) + 0.6;
        if !in_range { self.contrary_pitch = true; }
        if in_range {
            if let Some(last) = self.last { self.covered += (t - last).clamp(0.0, 0.03); }
            self.last = Some(t);
            if self.pitches.last().is_none_or(|p| t - p.0 >= 0.015) { self.pitches.push((t, off)); }
        }
    }

    /// Ringing neighbouring strings may defeat a monophonic tracker. For an ordinary hold,
    /// the session can prove the expected tone spectrally, but never override a clear wrong
    /// pitch, or infer a bend/vibrato from a static spectrum.
    pub fn spectral_target(&self) -> Option<f64> {
        (!self.contrary_pitch && self.target.is_none() && self.techniques.vibrato != Some(true)
            && self.techniques.palm_mute != Some(true)).then_some(self.base).flatten()
    }

    pub fn spectral_hold(&mut self, time: f64, heard: bool) {
        if time <= self.spectral_after { return; }
        self.spectral_after = time;
        let t = time - self.attack;
        if !heard || self.spectral_target().is_none() || t < 0.015 || t > self.duration || self.last.is_some_and(|last| t <= last) { return; }
        if let Some(last) = self.last { self.covered += (t - last).clamp(0.0, 0.03); }
        self.last = Some(t);
    }

    pub fn level(&mut self, time: f64, db: f32) {
        let t = time - self.attack;
        if t < 0.015 || t > self.duration || t <= self.last_level_time { return; }
        self.last_level_time = t;
        if t < 0.07 { self.peak_db = self.peak_db.max(db); }
        if (0.17..=0.22).contains(&t) { self.tail_db = self.tail_db.max(db); }
        // For chords the spectral verifier proved the attack; follow its audible envelope.
        if self.base.is_none() && db > -60.0 {
            if let Some(last) = self.last { self.covered += (t - last).clamp(0.0, 0.03); }
            self.last = Some(t);
        }
    }

    pub fn passed(&self) -> bool {
        if self.techniques.palm_mute == Some(true) {
            // A pitched, rapidly damped sound, rather than a ringing open note or dead click.
            return (self.base.is_none() || self.pitches.len() >= 3) && self.peak_db > -55.0 && self.peak_db - self.tail_db >= 8.0;
        }
        if self.covered < self.duration * 0.65 || self.last.is_none_or(|t| t < self.duration * 0.75) { return false; }
        if let Some(target) = self.target.filter(|t| t.abs() > 0.05) {
            let near = |fraction: f64, tolerance: f64| self.pitches.iter().any(|&(_, p)| (p - target * fraction).abs() <= tolerance);
            // Require a trajectory through the interval, not an unrelated second attack at
            // the destination. A bend must reach its requested amount, in the right octave.
            let endpoint = (target.abs() * 0.3).clamp(0.025, 0.4);
            let trajectory = (target.abs() * 0.2).clamp(0.015, 0.3);
            if !near(1.0, endpoint) || !near(0.35, trajectory) || !near(0.65, trajectory) { return false; }
        }
        if self.techniques.vibrato == Some(true) {
            let mut previous = None;
            let (mut direction, mut turns, mut lo, mut hi) = (0i32, 0, f64::INFINITY, f64::NEG_INFINITY);
            for &(t, p) in &self.pitches {
                if t < 0.06 { continue; }
                lo = lo.min(p); hi = hi.max(p);
                if let Some(last) = previous {
                    let d: f64 = p - last;
                    if d.abs() >= 0.035 {
                        let sign = if d > 0.0 { 1 } else { -1 };
                        if direction != 0 && sign != direction { turns += 1; }
                        direction = sign;
                    }
                }
                previous = Some(p);
            }
            if turns < 3 || !(0.25..=1.2).contains(&(hi - lo)) { return false; }
        }
        true
    }
}

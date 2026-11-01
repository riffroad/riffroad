//! Offline windowed-sinc resampler (IR loading, test material). Not for the real-time path.

/// Resamples `x` from `from_hz` to `to_hz` with a Blackman-windowed sinc of `zeros` zero crossings
/// per side; the cutoff sits at 95 % of the lower Nyquist frequency.
pub fn resample(x: &[f32], from_hz: f32, to_hz: f32, zeros: usize) -> Vec<f32> {
    if (from_hz - to_hz).abs() < 1e-6 || x.is_empty() {
        return x.to_vec();
    }
    let ratio = to_hz as f64 / from_hz as f64;
    let cutoff = 0.95 * ratio.min(1.0);
    let half = zeros as f64 / cutoff;
    let out_len = (x.len() as f64 * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let t = n as f64 / ratio;
        let first = (t - half).ceil().max(0.0) as usize;
        let last = ((t + half).floor() as usize).min(x.len() - 1);
        let mut acc = 0.0f64;
        for (k, &v) in x.iter().enumerate().take(last + 1).skip(first) {
            let d = t - k as f64;
            let w = d / half;
            if w.abs() >= 1.0 {
                continue;
            }
            let arg = std::f64::consts::PI * cutoff * d;
            let sinc = if arg.abs() < 1e-12 { 1.0 } else { arg.sin() / arg };
            let window = 0.42 + 0.5 * (std::f64::consts::PI * w).cos() + 0.08 * (2.0 * std::f64::consts::PI * w).cos();
            acc += v as f64 * cutoff * sinc * window;
        }
        out.push(acc as f32);
    }
    out
}

/// Kernel positions tabulated per input sample by `resample_fast`.
const PHASES: usize = 512;
/// Output samples from which `resample_fast` shares the work among threads (a second at 48 kHz).
const PARALLEL_FROM: usize = 48_000;

/// `resample`, with its kernel tabulated (`PHASES` points per input sample, linearly
/// interpolated): the same output to about 1e-5, fast enough for whole songs.
pub fn resample_fast(x: &[f32], from_hz: f32, to_hz: f32, zeros: usize) -> Vec<f32> {
    if (from_hz - to_hz).abs() < 1e-6 || x.is_empty() {
        return x.to_vec();
    }
    let ratio = to_hz as f64 / from_hz as f64;
    let cutoff = 0.95 * ratio.min(1.0);
    let half = zeros as f64 / cutoff;
    let table: Vec<f32> = (0..=(half * PHASES as f64).ceil() as usize + 1)
        .map(|i| {
            let d = i as f64 / PHASES as f64;
            let w = d / half;
            if w >= 1.0 {
                return 0.0;
            }
            let arg = std::f64::consts::PI * cutoff * d;
            let sinc = if arg < 1e-12 { 1.0 } else { arg.sin() / arg };
            let window = 0.42 + 0.5 * (std::f64::consts::PI * w).cos() + 0.08 * (2.0 * std::f64::consts::PI * w).cos();
            (cutoff * sinc * window) as f32
        })
        .collect();
    let sample = |n: usize| -> f32 {
        let t = n as f64 / ratio;
        let first = (t - half).ceil().max(0.0) as usize;
        let last = ((t + half).floor() as usize).min(x.len() - 1);
        let mut acc = 0.0f32;
        for (k, &v) in x.iter().enumerate().take(last + 1).skip(first) {
            let at = (t - k as f64).abs() * PHASES as f64;
            let i = at as usize;
            let frac = (at - i as f64) as f32;
            acc += v * (table[i] + (table[i + 1] - table[i]) * frac);
        }
        acc
    };
    let mut out = vec![0.0f32; (x.len() as f64 * ratio).ceil() as usize];
    // Each output sample is a sum of its own: a song is shared among the cores.
    let cores = if out.len() < PARALLEL_FROM { 1 } else { std::thread::available_parallelism().map_or(1, |n| n.get()).min(8) };
    let chunk = out.len().div_ceil(cores).max(1);
    std::thread::scope(|scope| {
        for (c, part) in out.chunks_mut(chunk).enumerate() {
            let sample = &sample;
            scope.spawn(move || part.iter_mut().enumerate().for_each(|(j, o)| *o = sample(c * chunk + j)));
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::{resample, resample_fast};

    #[test]
    fn the_tabulated_kernel_gives_the_same_output() {
        let mut seed = 1u32;
        let x: Vec<f32> = (0..3000)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect();
        for (from, to) in [(50_830.0, 48_000.0), (45_300.0, 48_000.0), (44_100.0, 48_000.0)] {
            let (slow, fast) = (resample(&x, from, to, 16), resample_fast(&x, from, to, 16));
            assert_eq!(slow.len(), fast.len());
            let worst = slow.iter().zip(&fast).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-4, "{from} → {to}: {worst}");
        }
    }

    #[test]
    fn a_long_signal_shared_among_threads_gives_the_same_output() {
        // Past PARALLEL_FROM output samples: computed in chunks, joined where they meet.
        let x: Vec<f32> = (0..60_000).map(|i| (i as f32 * 0.0173).sin() * (i as f32 * 0.00031).cos()).collect();
        let (slow, fast) = (resample(&x, 44_100.0, 48_000.0, 16), resample_fast(&x, 44_100.0, 48_000.0, 16));
        assert_eq!(slow.len(), fast.len());
        let worst = slow.iter().zip(&fast).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-4, "{worst}");
    }

    #[test]
    fn sine_survives_44k1_to_48k() {
        let f = 1000.0;
        let x: Vec<f32> = (0..4410).map(|i| (std::f32::consts::TAU * f * i as f32 / 44_100.0).sin()).collect();
        let y = resample(&x, 44_100.0, 48_000.0, 32);
        assert_eq!(y.len(), 4800);
        // Ignore edges where the kernel runs out of input.
        for (n, v) in y.iter().enumerate().skip(100).take(4600) {
            let want = (std::f32::consts::TAU * f * n as f32 / 48_000.0).sin();
            assert!((v - want).abs() < 2e-3, "n={n}: {v} vs {want}");
        }
    }
}

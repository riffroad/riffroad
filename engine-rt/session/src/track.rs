use std::fs::File;
use std::path::Path;

use lewton::inside_ogg::OggStreamReader;
use opensmith_audio::Track;
use opensmith_dsp::fx::resample::resample_fast;

#[derive(Debug, thiserror::Error)]
pub enum TrackError {
    #[error("{0}: {1}")]
    Wav(String, #[source] hound::Error),
    #[error("{0}: {1}")]
    Ogg(String, #[source] lewton::VorbisError),
    #[error("{0}: {1}")]
    Io(String, #[source] std::io::Error),
}

/// Decodes a backing track (WAV, or Ogg Vorbis) to stereo at `sample_rate` (resampled if needed).
pub fn load_track(path: &Path, sample_rate: u32) -> Result<Track, TrackError> {
    let (data, channels) = decode(path, sample_rate)?;
    Ok(Track::from_interleaved(&data, channels))
}

/// A backing track with the song's own guitar as a stem (`guitar`), silent until its gain is set.
pub fn load_track_with_stem(path: &Path, guitar: &Path, sample_rate: u32) -> Result<Track, TrackError> {
    // Both decoded at once, each on its own core.
    let (track, stem) = std::thread::scope(|scope| {
        let stem = scope.spawn(|| decode(guitar, sample_rate));
        (load_track(path, sample_rate), stem.join())
    });
    let (data, channels) = stem.unwrap_or_else(|e| std::panic::resume_unwind(e))?;
    Ok(track?.with_stem(&data, channels))
}

/// `seconds` of a recording from `start` s, its channels mixed to one, at the file's own rate
/// (no decoding of the rest: a song's preview); the rate is returned with the samples.
pub fn read_excerpt(path: &Path, start: f64, seconds: f64) -> Result<(Vec<f32>, u32), TrackError> {
    let (data, rate, channels) = if is_ogg(path) { read_ogg(path, start, Some(seconds))? } else { read_wav(path, start, Some(seconds))? };
    Ok((data.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect(), rate))
}

/// The songs shipped with the app are Ogg Vorbis (a tenth of their WAV's size); imports are WAV.
fn is_ogg(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("ogg"))
}

/// A WAV from `start` s (`seconds` of it, or all): interleaved samples, rate, channels.
fn read_wav(path: &Path, start: f64, seconds: Option<f64>) -> Result<(Vec<f32>, u32, usize), TrackError> {
    let err = |e: hound::Error| TrackError::Wav(path.display().to_string(), e);
    let mut reader = hound::WavReader::open(path).map_err(err)?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    if start > 0.0 {
        let first = ((start * f64::from(spec.sample_rate)) as u32).min(reader.duration());
        reader.seek(first).map_err(|e| err(hound::Error::IoError(e)))?;
    }
    let n = seconds.map_or(usize::MAX, |s| (s * f64::from(spec.sample_rate)) as usize * channels);
    let data: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().take(n).collect::<Result<_, _>>().map_err(err)?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample.clamp(1, 32) - 1)) as f32;
            reader.samples::<i32>().take(n).map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>().map_err(err)?
        }
    };
    Ok((data, spec.sample_rate, channels))
}

/// An Ogg Vorbis file from `start` s and `seconds` of it, or all: interleaved samples, rate,
/// channels. A seek lands on a page; the samples before `start` are cut once the end of a page
/// says where the decoded ones stand.
fn read_ogg(path: &Path, start: f64, seconds: Option<f64>) -> Result<(Vec<f32>, u32, usize), TrackError> {
    let err = |e: lewton::VorbisError| TrackError::Ogg(path.display().to_string(), e);
    let file = File::open(path).map_err(|e| TrackError::Io(path.display().to_string(), e))?;
    let mut ogg = OggStreamReader::new(file).map_err(err)?;
    let rate = ogg.ident_hdr.audio_sample_rate;
    let channels = usize::from(ogg.ident_hdr.audio_channels.max(1));
    let first = (start.max(0.0) * f64::from(rate)) as u64;
    // The frame the first decoded sample stands at, once known.
    let mut origin = if first > 0 {
        ogg.seek_absgp_pg(first).map_err(err)?;
        None
    } else {
        Some(0)
    };
    let n = seconds.map_or(usize::MAX, |s| (s * f64::from(rate)) as usize * channels);
    let mut data = Vec::new();
    while origin.is_none() || data.len() < n {
        let packet = match ogg.read_dec_packet_itl() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            // A seek can land on the headers' page: on to the audio.
            Err(lewton::VorbisError::BadAudio(lewton::audio::AudioReadError::AudioIsHeader)) => continue,
            Err(e) => return Err(err(e)),
        };
        data.extend(packet.iter().map(|&s| f32::from(s) / 32768.0));
        if origin.is_none() {
            origin = ogg.get_last_absgp().map(|end| end.saturating_sub((data.len() / channels) as u64));
        }
        if let Some(at) = origin.filter(|&at| at < first) {
            let early = ((first - at) as usize * channels).min(data.len());
            data.drain(..early);
            origin = Some(at + (early / channels) as u64);
        }
    }
    data.truncate(n);
    Ok((data, rate, channels))
}

/// Interleaved samples at `sample_rate` and their channel count.
fn decode(path: &Path, sample_rate: u32) -> Result<(Vec<f32>, usize), TrackError> {
    let (data, rate, channels) = if is_ogg(path) { read_ogg(path, 0.0, None)? } else { read_wav(path, 0.0, None)? };
    if rate == sample_rate {
        return Ok((data, channels));
    }
    let kept = channels.min(2);
    let resampled: Vec<Vec<f32>> = (0..kept)
        .map(|c| {
            let x: Vec<f32> = data.iter().skip(c).step_by(channels).copied().collect();
            resample_fast(&x, rate as f32, sample_rate as f32, 16)
        })
        .collect();
    let frames = resampled.iter().map(Vec::len).min().unwrap_or(0);
    let interleaved: Vec<f32> = (0..frames).flat_map(|i| resampled.iter().map(move |ch| ch[i])).collect();
    Ok((interleaved, kept))
}

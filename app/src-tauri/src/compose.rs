//! Songs the engine writes and records (`opensmith_session::songwriter` and `studio`), put in the
//! library like any other: a folder with their chart, the backing and the guitar in Ogg Vorbis.

use std::fs;
use std::io::BufWriter;
use std::num::{NonZeroU32, NonZeroU8};
use std::path::{Path, PathBuf};

use opensmith_dsp::guitar::Samples;
use opensmith_session::samples::SampleBank;
use opensmith_session::songwriter::{write, Style};
use opensmith_session::studio::{record, SAMPLE_RATE};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

/// Where in the library the songs Riffroad writes go.
const FOLDER: &str = "Riffroad";

/// A song in `style`, written and recorded from `seed`, put in `library`: its chart's path.
pub fn compose(library: &Path, style: Style, seed: u64) -> Result<PathBuf, String> {
    let song = write(style, seed);
    let players = SampleBank::players().map_err(|e| format!("notes enregistrées : {e}"))?;
    let banks: [Option<&dyn Samples>; 2] = [Some(&players[0]), Some(&players[1])];
    let recording = record(&song.strokes, &song.rhythm, song.tone, banks, song.seconds, seed);
    let folder = unused(&library.join(FOLDER).join(format!("Riffroad - {}", song.chart.meta.title)));
    fs::create_dir_all(&folder).map_err(|e| format!("{} : {e}", folder.display()))?;
    ogg(&folder.join("backing.ogg"), &recording.backing, seed)?;
    ogg(&folder.join("guitar.ogg"), &recording.guitar, seed.wrapping_add(1))?;
    let mut chart = song.chart;
    chart.audio.backing = Some("backing.ogg".into());
    chart.audio.guitar = Some("guitar.ogg".into());
    let path = folder.join("song_chart.json");
    let json = serde_json::to_string_pretty(&chart).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("{} : {e}", path.display()))?;
    Ok(path)
}

/// `base`, or `base 2`, `base 3`… the first not taken: a title can come twice.
fn unused(base: &Path) -> PathBuf {
    let name = base.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    (1..).map(|k| if k == 1 { base.to_path_buf() } else { base.with_file_name(format!("{name} {k}")) }).find(|p| !p.exists()).expect("a free name")
}

/// Interleaved stereo at the studio's rate as Ogg Vorbis, quality 5 (about 160 kbit/s).
fn ogg(path: &Path, stereo: &[f32], serial: u64) -> Result<(), String> {
    let err = |e: vorbis_rs::VorbisError| format!("{} : {e}", path.display());
    let file = fs::File::create(path).map_err(|e| format!("{} : {e}", path.display()))?;
    let rate = NonZeroU32::new(SAMPLE_RATE).expect("a rate");
    let mut encoder = VorbisEncoderBuilder::new_with_serial(rate, NonZeroU8::new(2).expect("two"), BufWriter::new(file), serial as i32)
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr { target_quality: 0.5 })
        .build()
        .map_err(err)?;
    for block in stereo.chunks(2 * 4096) {
        let left: Vec<f32> = block.iter().step_by(2).copied().collect();
        let right: Vec<f32> = block.iter().skip(1).step_by(2).copied().collect();
        encoder.encode_audio_block([left, right]).map_err(err)?;
    }
    encoder.finish().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensmith_game::Chart;
    use opensmith_session::load_track_with_stem;

    #[test]
    fn a_song_composed_lands_in_the_library_with_its_audio_and_plays() {
        let library = std::env::temp_dir().join(format!("riffroad-compose-{}", std::process::id()));
        let _ = fs::remove_dir_all(&library);
        let path = compose(&library, Style::Punk, 3).expect("composed");
        assert!(path.starts_with(library.join(FOLDER)));
        let chart = Chart::load(&path).expect("a chart");
        assert_eq!(chart.meta.source.kind, "generated");
        let folder = path.parent().unwrap();
        let track = load_track_with_stem(&folder.join("backing.ogg"), &folder.join("guitar.ogg"), SAMPLE_RATE).expect("its audio reads");
        let seconds = track.frames() as f64 / SAMPLE_RATE as f64;
        assert!((seconds - chart.meta.duration).abs() < 2.0, "{seconds:.1} s of audio for a {:.1} s chart", chart.meta.duration);
        // The same song again: a folder of its own.
        let again = compose(&library, Style::Punk, 3).expect("composed");
        assert_ne!(again.parent(), path.parent());
        assert!(again.parent().unwrap().to_string_lossy().ends_with(" 2"));
        let _ = fs::remove_dir_all(&library);
    }
}

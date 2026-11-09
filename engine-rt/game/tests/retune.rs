//! Playing a song on the guitar as it is tuned: the chart takes the guitar's tuning, the audio
//! is transposed.

use opensmith_game::Chart;

fn chart(name: &str, strings: [i32; 6], cents: f64) -> Chart {
    let json = format!(
        r#"{{"format":"opensmith-chart","version":1,
        "meta":{{"title":"T","artist":"A","album":null,"year":null,"duration":8.0,"source":{{"kind":"audio","file":"x"}},"generator":"test"}},
        "audio":{{"backing":null,"guitar":null,"mix":null,"offset":0.0}},
        "arrangement":{{"name":"Lead","type":"lead","tuning":{{"name":"{name}","strings":{strings:?},"cents":{cents}}},"capo":0,"maxDifficulty":0}},
        "tempo":{{"bpm":120.0,"timeSignature":[4,4]}},
        "beats":[{{"time":0.0,"bar":1}}],"sections":[],"phrases":[{{"name":"A","start":0.0,"end":8.0,"maxDifficulty":0}}],"chordTemplates":[],
        "notes":[{{"time":1.0,"string":0,"fret":3,"sustain":0.0,"levels":[0,0]}}],"chords":[],"anchors":[],"handShapes":[]}}"#
    );
    Chart::from_json(&json).unwrap()
}

const E: [i32; 6] = [40, 45, 50, 55, 59, 64];
const DROP_D: [i32; 6] = [38, 45, 50, 55, 59, 64];

#[test]
fn a_song_in_e_flat_is_played_in_e_standard_a_semitone_up() {
    let mut c = chart("Eb Standard", [39, 44, 49, 54, 58, 63], 0.0);
    assert_eq!(c.retune_to(&E, "E Standard"), Some(1.0));
    assert_eq!((c.arrangement.tuning.name.as_str(), c.arrangement.tuning.strings.as_slice()), ("E Standard", &E[..]));
    assert_eq!(c.pitch(0, 3), 43, "the same fret, the guitar's pitch");
}

#[test]
fn drop_c_on_a_guitar_in_drop_d_and_a_recording_off_a440() {
    let mut c = chart("Drop C", [36, 43, 48, 53, 57, 62], 0.0);
    assert_eq!(c.retune_to(&DROP_D, "Drop D"), Some(2.0));
    // E standard recorded 30 cents flat: brought up to A440, the guitar stays as it is.
    let mut c = chart("E Standard", E, -30.0);
    let shift = c.retune_to(&E, "E Standard").unwrap();
    assert!((shift - 0.3).abs() < 1e-9 && c.arrangement.tuning.cents == 0.0);
}

#[test]
fn what_cannot_be_transposed_is_left_alone() {
    // Already the guitar's tuning; another layout; too far down (6 semitones); another string
    // count.
    for (name, strings) in [("E Standard", E), ("Drop D", DROP_D), ("B Standard", [34, 39, 44, 49, 53, 58])] {
        let mut c = chart(name, strings, 0.0);
        assert_eq!(c.retune_to(&E, "E Standard"), None, "{name}");
        assert_eq!(c.arrangement.tuning.strings, strings, "{name} unchanged");
    }
    let mut c = chart("E Standard", E, 0.0);
    assert_eq!(c.retune_to(&[40, 45, 50, 55], "Bass"), None);
}

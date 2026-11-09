use opensmith_game::Chart;
use serde_json::{json, Value};

fn fixture() -> Value { serde_json::from_str(include_str!("fixtures/demo_rock.json")).unwrap() }
fn rejected(mut edit: impl FnMut(&mut Value)) {
    let mut c = fixture(); edit(&mut c);
    assert!(Chart::from_json(&c.to_string()).is_err(), "accepted malformed chart: {c}");
}

#[test]
fn unsupported_string_counts_are_refused_before_rendering() {
    for count in [0, 3, 7, 8] { rejected(|c| c["arrangement"]["tuning"]["strings"] = json!(vec![40; count])); }
}

#[test]
fn inconsistent_shapes_and_references_cannot_reach_the_judge() {
    rejected(|c| c["chordTemplates"][0]["frets"] = json!([0, 0, 0, 0, 0, 0, 0]));
    rejected(|c| c["chordTemplates"][0]["fingers"] = json!([]));
    rejected(|c| c["chordTemplates"][0]["frets"] = json!(vec![-1; 6]));
    rejected(|c| c["chords"][0]["template"] = json!(999));
    rejected(|c| c["handShapes"] = json!([{"template":999,"start":1.0,"end":2.0}]));
    rejected(|c| c["notes"][0]["string"] = json!(6));
}

#[test]
fn invalid_times_spans_and_levels_are_rejected() {
    rejected(|c| c["meta"]["duration"] = json!(-1));
    rejected(|c| c["notes"][0]["sustain"] = json!(-1));
    rejected(|c| c["notes"][0]["time"] = json!(1000));
    rejected(|c| c["notes"][0]["levels"] = json!([4, 0]));
    rejected(|c| c["notes"][0]["levels"] = json!([0, 999]));
    rejected(|c| c["notes"].as_array_mut().unwrap().reverse());
    rejected(|c| c["phrases"][1]["start"] = json!(0));
    rejected(|c| c["anchors"][0]["width"] = json!(0));
    rejected(|c| c["tempo"]["bpm"] = json!(0));
}

#[test]
fn the_valid_fixture_preserves_event_indices() {
    let c = fixture();
    let loaded = Chart::from_json(&c.to_string()).unwrap();
    assert_eq!(loaded.notes.len(), c["notes"].as_array().unwrap().len());
    assert_eq!(loaded.notes[0].time, c["notes"][0]["time"].as_f64().unwrap());
}

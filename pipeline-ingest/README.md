# pipeline-ingest

Module B de Riffroad : transforme une chanson ou une tablature en chart jouable (`song_chart.json`, format [../schema/chart.schema.json](../schema/chart.schema.json)).

| Module | Rôle |
|---|---|
| `separation.py` | Demucs `htdemucs_6s` sur le GPU Apple (MPS) : guitare d'un côté, backing track de l'autre |
| `transcription.py` | Basic Pitch (CoreML) puis nettoyage : fragments fusionnés, harmoniques fantômes et notes sans attaque retirées |
| `beats.py` | Tempo, battements (précision ~5 ms) et barres de mesure |
| `fingering.py` | Solveur de doigtés Viterbi (notes → corde/case jouables) |
| `builder.py` | Quantification, accords nommés avec doigts, phrases, sections, 5 niveaux de difficulté, anchors |
| `importers/` | Guitar Pro 3/4/5 ; d'autres formats arrivent par des plugins (commandes `opensmith_ingest.commands`) |
| `benchmark.py` | Doigtés comparés à de vrais guitaristes (GuitarSet) |
| `synth.py` | Morceau synthétique avec vérité terrain (tests, démo) |

Python 3.11 obligatoire : sur macOS, Basic Pitch tire `tensorflow-macos` au-delà de 3.11.

```bash
uv sync
```

```bash
uv run opensmith-ingest audio chanson.mp3 -o ../out/chanson
```

```bash
uv run opensmith-ingest bench-guitarset
```

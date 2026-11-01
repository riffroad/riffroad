# Riffroad — guide détaillé

*Le [README](../README.fr.md) présente le jeu ; ce guide détaille les outils en ligne de commande, le développement et toutes les fonctions de l'app.*

## Moteur audio (Rust)

Prérequis : Mac Apple Silicon, Rust stable (`rustup`).

Lancer tous les tests :

```bash
cargo test --workspace
```

Lister les périphériques audio (le câble guitare USB est signalé s'il est branché) :

```bash
cargo run --release -p opensmith-diag -- devices
```

Jouer en direct (guitare → détection de notes + ampli → casque) :

```bash
cargo run --release -p opensmith-diag -- run
```

Sans câble, l'entrée par défaut du Mac est utilisée et le retour son est coupé pour éviter le larsen ; `--monitor` le force.

Vérifier la détection sur signaux synthétiques (latence par corde, accords, CPU) :

```bash
cargo run --release -p opensmith-diag -- selftest
```

Générer des fichiers de test (cordes à vide, accords, gamme) dans `out/testdata` :

```bash
cargo run --release -p opensmith-diag -- gen
```

Passer un enregistrement dans la chaîne (notes détectées + son traité) :

```bash
cargo run --release -p opensmith-diag -- render in.wav out.wav --drive 0.6
```

## Transformer une chanson en niveau jouable

Prérequis : `uv` et `ffmpeg` (`brew install uv ffmpeg`). Une fois, dans `pipeline-ingest` :

```bash
cd pipeline-ingest && uv sync
```

La pochette du MP3 (ou la vignette de la vidéo) est reprise dans la liste des morceaux et pendant le jeu.

**Depuis l'app** : glisse un ou plusieurs MP3 (WAV, FLAC, M4A… ou un fichier Guitar Pro) dans la fenêtre, la conversion démarre avec sa barre de progression. Glisse un dossier, ou clique « Choisir un dossier… », pour en faire ton dossier de musique : l'app liste tous ses morceaux, ceux déjà convertis sont jouables tout de suite, les autres se convertissent un par un ou avec « Tout convertir ». Compte une demi-minute par chanson.

**Partition exacte avec une tablature** : pose le fichier Guitar Pro (.gp3, .gp4, .gp5) à côté du MP3, avec un nom qui dit le même morceau (`artiste-titre.gp3` pour `Artiste - Titre (Official Music Video).mp3`). La conversion prend alors les notes de la tablature et les cale sur l'enregistrement au lieu de les transcrire. Pour un morceau déjà converti, le dossier de musique affiche « Appliquer la tablature ».

**En ligne de commande** :

Un MP3 → stems, transcription, tablature jouable avec 5 niveaux de difficulté :

```bash
uv run opensmith-ingest audio ~/Music/chanson.mp3 -o ../out/chanson
```

Recalculer les tablatures de morceaux déjà convertis (après une amélioration du jeu), sans refaire la séparation des pistes :

```bash
uv run opensmith-ingest rechart ../out/chanson ../out/demo/chart
```

Voir le résultat en tablature, au niveau voulu (0 = débutant, 4 = complet) :

```bash
uv run opensmith-ingest tab ../out/chanson/song_chart.json --level 2
```

Importer une tablature existante (Guitar Pro 3/4/5), sans audio :

```bash
uv run opensmith-ingest guitarpro morceau.gp5 -o ../out/morceau
```

Caler une tablature Guitar Pro sur un morceau déjà converti (`audio` le fait seul quand la tablature est à côté du MP3 ; `--tab none` pour transcrire quand même) :

```bash
uv run opensmith-ingest retab morceau.gp4 -o ../out/chanson
```

Importer un feedpak (dossier ou archive `.feedpak`), son chart écrit à la main et son audio (`--list` montre ses arrangements, `--arrangement` en choisit un) :

```bash
uv run opensmith-ingest feedpak morceau.feedpak -o ../out/morceau
```

Mesurer le pipeline MP3 contre les charts écrits à la main d'une bibliothèque : chaque morceau tiré au hasard repasse par le pipeline depuis son audio, et chaque étage (transcription brute, notes vérifiées, chart final ; `--mix` ajoute la transcription du mix sans séparation) est comparé à ce qui a été écrit. Le cache (`~/.cache/opensmith-bench`) garde la piste guitare et les transcriptions : `--rechart` remesure une nouvelle règle de chart en quelques secondes par morceau, sans refaire la séparation.

```bash
uv run opensmith-ingest bench ~/Music/OpenSmith --limit 30 --mix
```

Tests Python (rapides, puis de bout en bout ~20 s) :

```bash
uv run pytest
```

```bash
uv run pytest -m slow
```

## Jouer

Prérequis : Node 20+ (`brew install node`). Une fois, dans `app` :

```bash
cd app && npm install
```

L'application de bureau (moteur audio natif, câble guitare USB ou interface audio, jugement de ce que tu joues) :

```bash
npm run tauri dev
```

L'autoroute de notes dans le navigateur, sans guitare (un joueur automatique joue à ta place, avec la vraie difficulté dynamique) :

```bash
npm run dev
```

Puis ouvrir http://localhost:1420. Les morceaux sont ceux de `out/` (créés par `opensmith-ingest`) ; `OPENSMITH_LIBRARY=/chemin` pour un autre dossier.

**Temps de réponse** : Maj+P (ou `?perf` dans l'adresse) affiche le temps de chaque clic jusqu'à l'image qui le montre, les étapes du lancement d'un morceau et les images en retard. L'app de bureau les écrit aussi dans son journal (`perf : …`) ; `OPENSMITH_TOUR=1` lui fait parcourir les menus deux fois puis lancer le premier morceau, fenêtre au premier plan (`OPENSMITH_TOUR=open-library,open-trophies` pour quelques écrans seulement) :

```bash
open -n --stderr /tmp/tour.log --env OPENSMITH_TOUR=1 app/src-tauri/target/release/bundle/macos/Riffroad.app
```

**Menu d'accueil** : Reprendre (le dernier morceau joué), Morceaux, Importer un morceau, Loop Trainer, Jouer librement, Accordeur, Réglages (onglets Audio & guitare, Latence & calibrage, Jeu).

**HUD matériel** (en haut à droite des menus) : l'entrée écoutée, son état et la latence mesurée, un vumètre en direct, l'interrupteur Guitare réelle / Démo auto (le jeu joue tout seul, sans compter dans la progression) et le Tuner.

**Importer un morceau** (menu, bouton « Importer » de Morceaux, ou glisser-déposer un MP3 ou un .gp n'importe où) : chaque import affiche ses étapes, séparation (Demucs) → tempo et notes (Basic Pitch) → doigté (Viterbi) → bibliothèque.

**Tout un dossier** (glissé sur la fenêtre, ou « Importer un dossier… ») : chaque fichier pas encore importé part dans la file et les morceaux arrivent un à un dans Morceaux pendant que tu joues (puce IMPORT dans le HUD). Pause, Vider la file ; fermer l'app interrompt l'import en cours, qui reprend au lancement suivant avec le reste de la file.

**Morceaux** : tape pour chercher (titre, artiste ou album, avec ou sans accents ; `/` pour y aller), trie par derniers joués, titre, artiste ou maîtrise, filtre par accordage ou par origine des notes : **Tablature** (Guitar Pro calée sur l'enregistrement), **Chart** (importé par un plugin), **IA** (transcrit depuis le MP3), **Partition** (tablature sans audio). Un clic ouvre la fiche du morceau (records, maîtrise par phrase) avec Jouer et Loop Trainer ; Entrée joue, Échap ferme la fiche puis revient au menu.

**Sans réaccorder** : Réglages → Jeu → « Ma guitare reste accordée en » choisit l'accordage où ta guitare reste. Les morceaux qui en sont à quelques demi-tons (toutes les cordes décalées d’autant, 5 au plus) ou enregistrés hors du La 440 sont transposés à son accordage au chargement : même tempo, mêmes cases sur la partition. Au-delà de deux demi-tons, le son se dégrade un peu.

**Guitariste virtuel** : pour régler la détection sans guitare, un guitariste de synthèse joue des partitions (propre, moyen ou débutant, avec des erreurs qu'il note), ses prises repassent dans tout le moteur, et le bilan dit ce que le jeu a compté ou refusé à tort :

```bash
cd engine-rt && cargo run --release -p opensmith-session --bin opensmith-simulate -- --player all --songs 24 ~/Music/OpenSmith
```

**Prises** : Réglages → Jeu → « Enregistrer ma guitare pendant les morceaux » garde chaque partie jouée au câble dans le dossier `.takes` de la bibliothèque (un dossier par partie, du lancement ou d'un saut à la fin ; pas le Loop Trainer ni le ralenti). Pour les rejouer dans le moteur tel qu'il est maintenant et comparer au score en direct :

```bash
cd engine-rt && cargo run --release -p opensmith-session --bin opensmith-replay -- ~/Music/OpenSmith/.takes
```

**Plusieurs arrangements** : un morceau peut avoir plusieurs partitions (lead, rythmique, combo…) dans son dossier : `song_chart.json` pour celle qu'on voit d'abord, `song_chart.<partie>.json` pour les autres (`song_chart.rhythm.json`…), même audio. La vignette dit combien il y en a, la fiche les propose en haut ; chacune a ses records et sa maîtrise, et la fiche s'ouvre sur le type choisi la dernière fois. Un importeur (feedpak, plugin) peut les écrire ainsi. Les arrangements de basse attendent une autoroute à quatre cordes.

**Carrière** (en tête du menu) : du garage aux bars puis aux clubs, semaine après semaine. Choisis une date parmi celles de la semaine, compose ta setlist, puis joue les morceaux enchaînés devant un public qui réagit à chaque note. Le concert rapporte des fans et un cachet, d'autant plus que les morceaux sont denses et joués au complet ; chaque pause refroidit la salle. La date décisive de chaque acte ouvre le suivant, et chaque saison de 12 semaines se termine par un bilan.

**Cinq actes** : garage, bars, clubs, festivals (le tremplin contre Les Vautours), stades (la dernière date et le Hall of Fame). Des événements chaque semaine ou presque (dénicheur, panne de courant, tête d'affiche qui annule…), un label avec ses objectifs de saison, un studio pour enregistrer un album, et trois niveaux d'exigence (Rookie, Pro, Légende) au début de chaque carrière.

**La semaine** (dans la carrière) : trois créneaux, un concert (deux avec le van), une répétition du groupe ou du repos. **Le groupe** : Max, Karim et Léa au départ, notés en précision, énergie et fiabilité, avec leur moral, et un marché pour recruter mieux. **Le matos** (Boutique) : deuxième guitare, stand de merch, ampli à lampes, sono, van.

**Répertoire** (dans la carrière) : le groupe ne joue que les morceaux qu'il a appris, chacun noté sur 99 (maîtrise et forme). La forme baisse après deux semaines sans rejouer le morceau ; le rejouer, en jeu libre ou en concert, la remonte. Chaque semaine, un dénicheur propose 3 morceaux à apprendre, à la difficulté de l'acte.

**Défi de la semaine** (dans la carrière) : un morceau imposé en Score Attack, le même toute la semaine. Bronze, argent ou or selon la précision, avec une prime à la clé.

**Ton groupe** (en haut de la carrière) : un nom et un logo (emblème, lettrage, couleurs), affichés en bannière dans le décor et sur les affiches. **Album souvenirs** : chaque concert laisse son affiche (salle, date, setlist, rappel, tampon « Complet ! »).

**Rappel** : un public encore à 80 % à la fin du concert rappelle le groupe. Choisis un des trois morceaux proposés (ou salue) : joué jusqu'au bout, le rappel rapporte des fans et un cachet en plus.

**Trophées** (au menu) : 14 trophées, sur scène en carrière et sur les morceaux dans tous les modes. Trois donnent une guitare qu'on ne peut pas acheter (Relique, Lave, Platine).

**Boutique de guitares** (dans la carrière) : les cachets des concerts achètent des guitares, de l'érable à la Galaxie (120 à 2 500 €). Une guitare achetée change la touche, les frettes, les repères et la tête du manche dans tous les modes, et reste même après une nouvelle carrière. Réglages → Jeu → Guitare pour changer de guitare.

**Décor** : Réglages → Jeu → Décor choisit le lieu derrière l'autoroute, du garage au stade (salle de concert, garage, petite fête, fête de quartier, gymnase, bar, club, festival, stade). Lumières, public et effets suivent la musique. En carrière, chaque salle a le sien.

**Pause** (Espace) : le score en cours et des réglages rapides sans quitter le morceau (volumes, canal de l'ampli, vitesse des notes, **difficulté** : Auto ou un niveau fixe, dès la phrase suivante), et « Menu principal » pour revenir à l'accueil. **`?`** affiche tous les raccourcis clavier. Au premier lancement de l'app de bureau, un guide fait brancher le câble, régler le niveau et la latence, puis accorder (« Guide de démarrage » dans les réglages pour le revoir).

**Jouer librement** : depuis le menu, branche ta guitare et joue sans morceau, dans l'ampli (Clair, Crunch, Lead, Métal, avec Gain, Graves, Médiums, Aigus, Volume, Écho, Réverb). Choisis la sortie (enceintes du Mac ou casque) dans le même écran ; le son reste pour les morceaux.

Avant de jouer, une fois, depuis le menu :
1. **Niveau d'entrée** (Réglages → Audio & guitare) : « Calibrer le niveau des micros », ne joue pas pendant 2 s puis gratte fort pendant 4 s. Choisis aussi l'entrée, la sortie, le seuil du noise gate et les volumes.
2. **Latence** (Réglages → Latence & calibrage) : « Calibrer », écoute les 4 clics d'annonce puis gratte une corde étouffée sur chacun des 12 clics suivants. La compensation se règle seule.

Chaque morceau commence par l'accordeur, réglé sur l'accordage du morceau (Drop C, Eb…) : joue chaque corde à vide et laisse-la sonner. Le cadran montre de combien tourner la clé (↻ tends, ↺ détends) ; la corde est validée après un instant à ±3 cents, puis la suivante. Ensuite « Jouer » ou Espace. Seul (menu ou bouton Tuner du HUD), l'accordeur propose 10 accordages.

Le câble guitare USB branché pendant que l'app tourne est pris tout de suite, et la Démo auto laisse la place à la guitare réelle. Sur l'accueil, les cordes du manche vibrent quand tu joues.

En jeu : Espace pause · R recommencer · ←/→ ±5 s · L Loop Trainer · I inverser les cordes (Mi grave en bas, comme une tablature) · Échap pause, une 2e fois morceaux.

**Loop Trainer** (depuis le menu, L, menu pause, ou « Travailler un passage » en fin de morceau) : choisis une partie du morceau (Couplet 1, Refrain 2, Solo… quand la tablature les nomme) ou une ou plusieurs phrases (Maj + clic), une vitesse de 40 à 100 % et l'Accélérateur (+5 % après chaque passe à 90 % ou plus). Le passage tourne en boucle avec un temps de préparation ; ↑/↓ change la vitesse, R recommence la passe. Dans l'app de bureau, le ralenti garde la hauteur des notes.

**Progression** : chaque morceau garde ses records, le niveau atteint par phrase et sa maîtrise (barre sous la pochette). Le **mode Maître** (réglages) efface les notes des phrases maîtrisées juste avant qu'elles arrivent : à jouer de mémoire.

**Score Attack** (fiche du morceau) : tout le morceau à un niveau fixe, Facile, Moyen, Difficile ou Maître (notes qui s'effacent), avec un bonus de points ×1 à ×3. Une phrase ratée sous le seuil de la difficulté compte un échec ; au troisième, le morceau s'arrête. Les 5 meilleures parties de chaque difficulté sont gardées.

Tests de l'interface :

```bash
npm test
```

## Organisation

| Dossier | Rôle |
|---|---|
| `engine-rt/dsp` | DSP temps réel : détection de hauteur MPM/YIN, suivi de notes, accords, gate, overdrive, cabinet |
| `engine-rt/audio` | CoreAudio : détection du câble, flux duplex 48 kHz / 64 frames, compensation de dérive d'horloge |
| `engine-rt/diag` | CLI de diagnostic `opensmith-diag` |
| `engine-rt/game` | Règles du jeu : lecture des charts, jugement des notes, score et série, difficulté dynamique |
| `engine-rt/session` | Partie en cours : piste d'accompagnement, horloge du morceau, attaques de la guitare replacées dans le morceau, flux d'événements pour l'interface |
| `schema` | Format des charts (JSON Schema), partagé entre Python, Rust et l'app |
| `pipeline-ingest` | MP3 → stems (Demucs) → notes (Basic Pitch) → doigtés (Viterbi) → chart ; imports Guitar Pro, autres formats par plugins |
| `app` | Application Tauri v2 (`src-tauri`) + autoroute de notes Three.js, HUD et écrans (`src`) |

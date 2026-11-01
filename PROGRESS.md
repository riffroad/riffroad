# OpenSmith — État d'avancement

_Dernière mise à jour : 2026-10-31 · Mac M1 Max, macOS 27.0.1, Rust 1.99.1, Python 3.11 (uv)_

| Étape | Contenu | État |
|---|---|---|
| 1 | Cœur audio temps réel, détection du câble, pitch MPM/YIN, chaîne DSP, tests | ✅ terminée |
| 2 | Solveur Viterbi + pipeline MP3 → tab + import GP/XML **+ cœur de jeu (score, difficulté dynamique)** | ✅ terminée |
| 3 | App Tauri v2 + Note Highway Three.js + boucle de jeu branchée sur le moteur | ✅ terminée |
| 4 | L'envie de rejouer : progression sauvegardée, Loop Trainer (boucle + ralenti sans changer la hauteur), mode Maître | ✅ terminée |
| 5 | Préparation open source : formats en plugins, app autonome sur un autre Mac, anglais, CI, morceau de démo, licence GPL-3.0 | ✅ terminée |
| 6 | Mesurer la transcription (banc d'essai) et le jugement (guitariste virtuel) ; dire pourquoi une note est ratée, la latence restante, la guitare du morceau | 🚧 en cours |

**Tests : 483 verts** — Rust 161 (moteur 144, app 17) + 6 lancés à la demande (vrai matériel, vrai pipeline, temps de lecture de la bibliothèque, entrées de ce Mac, notes entendues dans un WAV) ; interface 161 (Vitest) ; Python 161 rapides + 9 de bout en bout.

---

## Étape 6 — Mesurer, et mieux expliquer au joueur

- **Leçons à ton rythme : Attente, Lent, Normal, Rapide** (au-dessus du bouton de chaque leçon, enregistrements compris, retenu d'une fois sur l'autre). **Attente** : le morceau s'arrête sur chaque note ou accord et attend que la guitare le joue, puis repart — le temps de placer ses doigts ; compté pile sur le temps (le jeu l'a attendu), Espace laisse passer la note. Dans le moteur (`Session::set_wait`) : arrêté quand une note arrive, il écoute la guitare depuis l'arrêt, échantillon par échantillon (le temps du morceau ne bouge plus, il ne dit plus où est le son) : la hauteur du suiveur pour une note, le détecteur appris à chaque attaque pour une note douce ou un accord ; la prise continue pendant l'arrêt, et `own_takes.py` cherche l'attaque sur tout l'arrêt. Lent : moitié du tempo (une note toutes les 4 s pour les enregistrements). Test : un guitariste simulé qui ne joue que 0,8 s après chaque arrêt — 23 notes et accords sur 12 s de morceau, arrêté sur chacun, tous comptés pile sur le temps, aucun raté. Mesuré sur une première vraie séance « Ta guitare, note par note » (en Lent, guitare de débutant) : 76 notes justes sur 78, le détecteur n'en a pris aucune pour une autre ; les 18 refusées l'étaient pour le temps (10 en avance, 6 en retard, 2 pas jouées : 78 % des notes à ±100 ms, 96 % à ±200 ms).
- **Le morceau choisi joue en fond** : la fiche d'un morceau ouverte dans la bibliothèque, son refrain (la première section « chorus », sinon à partir du tiers) passe en boucle, 30 s avec fondus, sous le volume du jeu ; un autre morceau prend sa place en fondu enchaîné (le moteur garde l'ancien fond sonore le temps qu'il s'éteigne), et il s'arrête quand on lance le morceau ou qu'on quitte la bibliothèque. Lu directement dans le WAV à l'endroit voulu : 0,025 s par extrait, au lieu de 9 à 17 s en décodant tout le morceau. Tests : point de départ (refrain, tiers, fin du morceau), fondu entre deux fonds (`audio/tests/player.rs`).
- **Seules les entrées et sorties utilisables sont proposées** : le moteur tourne à 48 kHz ; un périphérique qui ne le fait pas (les entrées virtuelles de Wave Link, en 96 kHz seulement) ne s'ouvrait pas et l'app restait sur le précédent, ce qui bloquait le défilement des entrées. Mesuré en ouvrant chaque entrée de ce Mac (test lancé à la demande).
- **Plus de corde jaune allumée en permanence** : au repos, la corde de La (le jaune, la couleur la plus lumineuse) dépassait d'un rien le seuil du halo (luminance 0,645 pour un seuil à 0,62 ; les autres cordes entre 0,19 et 0,42) et brillait comme jouée, même sans guitare. Chaque corde est maintenant tenue au repos sous 0,5 de luminance ; jouée ou annoncée, elle brille comme avant. Au passage, les cordes de l'accueil vibrent au-dessus du bruit propre de l'entrée (un plancher suivi en continu, qui descend tout de suite et remonte de 3 dB par seconde au plus) au lieu d'un seuil fixe à −54 dBFS, que le souffle du câble pouvait franchir avec du gain : une corde vibre tant que la guitare sonne, et s'arrête avec elle.
- **Bibliothèque de 1 363 morceaux : ouverte sans attendre, et le morceau cliqué est le bon.** Les pochettes étaient lues sur le fil principal de l'app, toutes à l'ouverture (1 363 lectures qui figeaient l'interface) : elles le sont maintenant à côté, et seulement quand leur tuile approche de l'écran (5 au lieu de 1 363 à l'ouverture). À l'ouverture, la relecture de la bibliothèque (0,1 s une fois en mémoire, 1,15 s au premier passage, mesurées par un test lancé à la demande) refermait la fiche ouverte et redessinait toute la grille : un clic pendant ce temps tombait sur une autre tuile. La grille n'est plus redessinée que si des morceaux ont changé, en gardant la fiche ; deux lectures ne se chevauchent plus.
- **L'accordage suit d'un morceau à l'autre** (Réglages → Guitare, « Le dernier où je l'ai accordée », par défaut) : l'app retient l'accordage de la guitare (entre deux lancements aussi) et y décale les morceaux qui en sont à quelques demi-tons (comme un accordage fixe le faisait déjà) ; l'accordeur ne s'ouvre plus avant chaque morceau mais au premier de la session et quand l'accordage change vraiment (Mi standard → Drop D). Même règle pour les leçons. Tests : `tests/tuning.test.ts`.
- **Des sons de garage** : l'interface devient une guitare dans un ampli poussé (médiator qui gratte les cordes étouffées au survol, « chug » étouffé sur le Mi grave au clic, un ton plus bas pour revenir, le clic d'une pédale pour un réglage, un pain Mi-Fa saturé pour une erreur), le décompte se fait aux baguettes, une série déclenche une glissade de médiator, un niveau une glissade qui finit en harmonique sifflée, la note finale un Mi5 qui sonne jusqu'au larsen, un trophée un riff Mi5-Mi5-Sol5-La5 ; la foule est celle d'un petit club (moins de monde, les murs proches, les amplis qui ronflent sur scène, une bouteille, des sifflets). Cordes pincées (Karplus-Strong), ampli (écrêtage doux, baffle) et salle (réverbération de Schroeder) synthétisés.
- **Partition « Accords » pour chaque MP3 importé** (`song_chart.chords.json`, l'onglet « Accords » de la fiche du morceau) : l'accord de chaque temps reconnu sur les notes que Basic Pitch entend sur la piste guitare (accords majeurs, mineurs et power chords comparés aux notes du temps, puis lissés sur le morceau : changer d'accord coûte, une note de passage ne le change pas), joué dans la forme qu'un débutant apprend d'abord (Do, Sol, Ré, La mineur, Mi5… en accord ouvert là où il existe, sinon le barré ou le power chord le plus bas, selon l'accordage et le capo). Les niveaux faciles donnent la basse de l'accord sur chaque mesure, puis les deux cordes graves, puis l'accord entier sur chaque temps. Pourquoi : une partition note à note tirée d'un enregistrement mixé reste juste pour moins d'une note sur deux ; les accords, eux, sont justes sur **80 %** des temps (bonne fondamentale, majeur ou mineur respecté, un power chord allant avec les deux ; 77 % sur les accords qui ont une tierce), mesuré temps par temps sur 97 morceaux contre la partition rythmique écrite à la main. Les temps où la guitare se tait restent vides (seuil choisi sur 96 autres morceaux : 2,8 % des temps joués perdus, un quart des grattages dans les silences en moins ; le volume de la piste guitare ne fait pas mieux, le son des autres instruments y déborde). Réécrite aussi par `opensmith-ingest rechart`. Tests : `tests/test_chord_chart.py` (formes, accordages, reconnaissance, silences, niveaux), bout en bout sur le morceau de synthèse (Mi5 et La5 du riff retrouvés).
- **Jugement des notes : Indulgent / Normal / Strict** (Réglages → Jeu, à partir du morceau suivant) : la fenêtre de temps, la part des notes d'un accord à entendre, l'assurance qu'il faut au détecteur pour une note, et celle qu'il faut pour qu'une note étrangère fasse refuser l'accord. Choisis sur un balayage de huit réglages (guitariste virtuel, 24 morceaux ; bien joué compté / mal joué refusé du débutant) : Strict (±100 ms, ¾, 0,5, 0,85, le jugement d'avant) 85,7 / 83,5 % ; **Normal** (±100 ms, ⅔, 0,4, 0,93, par défaut) 88,3 / 81,4 % ; Indulgent (±120 ms, ½, 0,4, 0,97) 93,1 / 72,8 %, le plus indulgent qui refuse encore plus de 70 % des erreurs. Les projets voisins font de même : feedBack et Slopsmith ont un curseur « Chord Leniency » (60 % des cordes par défaut, aucune pénalité pour une note en trop) ; Rocksmith 2014 serait au contraire pointilleux (toutes les cordes d'un accord affiché), comme Rocksmith+ sur la qualité de l'accord. `opensmith-simulate --judging strict|normal|lenient` ou ses quatre valeurs.
- **Détecteur de notes appris aussi sur du vrai jeu** : même réseau (2 ms par appel), mais 30 % de chaque paquet d'exemples vient du vrai jeu de Guitar-TECHS. Mesuré honnêtement, appris sur deux guitaristes et testé sur le troisième : 77,9 % des notes reconnues contre 75,5 % ; le jeu compte 90,6 % de son bien joué (89,7 % avant) et refuse 94,9 % de son mal joué (95,1 %) ; sur les 24 morceaux, joueur propre 95,8 % (95,5 %), moyen 93,6 / 85,3 % (93,5 / 84,7 %), débutant 85,7 / 83,8 % (85,7 / 83,6 %). La version livrée a appris sur les trois guitaristes. Un réseau quatre fois plus gros, essayé avant, jugeait exactement pareil, 3,4 fois plus lentement : ce qui manquait, c'était du vrai jeu, pas de la taille.
- **Défauts de débutant dans le guitariste virtuel** : corde qui frise (le synthé fait claquer la corde contre la frette les premiers instants), doigt trop appuyé (note 20 à 40 cents trop haute), doigt trop léger (un « toc » sans hauteur ; dans un accord, une corde étouffée), bruit de médiator juste avant la note, accord gratté avant que les doigts soient en place (la moitié des cordes encore sur l'accord d'avant). Le débutant en fait 8 à 15 % chacun, le joueur moyen 1 à 3 %, le joueur propre jamais ; `opensmith-simulate` dit pour chacun ce que le jeu a compté ou refusé, et `cargo run --release -p opensmith-session --example listen` fait entendre une partie jouée. Ce que la mesure a corrigé : un accord dont le grattage frôle la corde à vide voisine (juste sous ou juste au-dessus de ses cordes) est compté (la note étrangère ne fait plus refuser l'accord quand c'est cette corde-là) : 43 → 80 % chez le débutant, 41 → 82 % chez le joueur moyen ; le guitariste virtuel ne frôle plus que des cordes voisines (le médiator ne saute pas une corde). Débutant, défauts compris : bien joué compté 80,8 → 85,7 %, mal joué refusé 84,3 → 83,6 % ; vrai jeu Guitar-TECHS inchangé (88,6 % / 95,1 %). Reste indulgent : une note étouffée par un doigt trop léger est comptée 4 fois sur 10 (son bref « toc » a la hauteur de la note ; la refuser demanderait de juger la tenue des notes, au risque de refuser les palm mutes).
- **Enregistrer sa guitare** (Leçons → « Ta guitare, pour mieux t'écouter ») : deux séances sans objectif, chaque corde à vide puis case par case jusqu'à la 12 (78 notes, 3 min), puis neuf accords quatre fois chacun ; la guitare est enregistrée pendant ces séances quel que soit le réglage (prises dans `~/Music/OpenSmith/.takes`). `models/notenet/own_takes.py` en fait des prises comme celles de Guitar-TECHS : chaque note recalée sur sa vraie attaque (un débutant joue en avance ou en retard), celles pas jouées ou pas à la bonne hauteur écartées (essayé sur le guitariste virtuel débutant : 91 % des bonnes notes gardées, aucune fausse ni oubliée ; un accord faux d'une seule corde passe encore pour juste). Les notes servent au guitariste virtuel (le son de la guitare et du câble du joueur), les accords au détecteur de notes.
- **Doigts des accords à l'import** (MP3, Guitar Pro) : chaque façon de poser quatre doigts qu'une main peut faire est pesée selon ce qui la rend peu naturelle (écart à un doigt par case, main déplacée, barrés de l'index ou d'un autre doigt, barré sous une corde à vide qui doit sonner, petit doigt, étirement…), et la plus naturelle est gardée (`fingering.chord_fingers`). Les poids ont été réglés pour retrouver les doigts que les guitaristes écrivent dans les tablatures, la main placée comme l'import la place : même doigté que l'humain sur 80 % des accords joués (79 % sur des formes qui n'ont pas servi au réglage ; les guitaristes ne sont d'accord entre eux que sur 90 %), contre 44 % pour l'ancienne règle (un doigt par case depuis la main). Les accords de base sortent comme dans les méthodes : Mi 2-3-1, La 1-2-3, Do 3-2-1, Ré 1-3-2, Fa barré 1-3-4-2-1-1, Si7 2-1-3-4. Les morceaux déjà importés gardent leurs doigts jusqu'à « Refaire la partition ».
- **Sons** : l'interface (survol, clic, retour, réglage changé, erreur), le jeu (décompte sur le tempo du morceau pendant les 3 s avant la musique, série atteinte, phrase qui monte de niveau ou maîtrisée, note de fin, fanfare d'un trophée ou d'une leçon réussie) et le public : en concert, la rumeur de la salle suit la jauge du public (plus discrète pendant un morceau), il acclame les séries, applaudit à la fin de chaque morceau d'autant plus fort qu'il est chaud, et tape dans les mains en rythme pour réclamer un rappel ; hors carrière, applaudissements à la fin d'un morceau noté B ou mieux. Pas de son par note : c'est la guitare qui sonne. Tous les sons sont fabriqués par l'app (`app/src/sounds.ts` : synthèse, bruit à graine fixe, aucun fichier ni licence), en arrière-plan au lancement (≈ 0,5 s), puis confiés au moteur qui les mélange par-dessus la guitare et le morceau, sur la même sortie (`engine-rt/audio/src/sfx.rs` : 24 voix réservées d'avance, le décompte calé à l'échantillon sur la position du morceau, la rumeur en boucle qui glisse vers son niveau). Deux nouveaux volumes dans Réglages → Audio : « Effets sonores » et « Public ». Pas encore écoutés au casque avec le câble.
- **Leçons pour débutant** (menu → Leçons) : dix leçons de moins d'une minute pour qui n'a jamais joué, sur un métronome (clics sur chaque temps, plus aigus en début de mesure), en Mi standard après l'accordeur : les six cordes à vide et leurs couleurs, jouer en rythme, les premières cases (un doigt par case), le 1-2-3-4, « Au clair de la lune » sur les cordes de Sol et de Si, puis E5, Mi mineur, La mineur, le passage Em ↔ Am et un riff E5-G5-A5. Chaque leçon dit ce qu'elle apprend et comment faire (doigts, cordes, geste), fixe un objectif (60 à 70 % des notes) et garde le meilleur résultat ; l'écran de fin dit « Leçon réussie ! » et propose la suivante, la prochaine à réussir est mise en avant. Jouée au ralenti, une leçon est un entraînement : elle ne compte pas. Les partitions sont faites par l'app (`app/src/lessons.ts`), la main reste en première position sauf quand un accord la déplace. Le guitariste virtuel les joue toutes dans le moteur : joueur propre 99,3 % compté, moyen 97,8 %, débutant 92,9 % du bien joué compté et 96,3 % du mal joué refusé (un accord G5 du riff parfois pris pour un autre). Pas encore essayées avec une vraie guitare.
- **Suivi des entraînements** : `opensmith-ingest bench-view --trainings <dossier>` ajoute à la page du banc une carte par entraînement décrit dans le dossier (un JSON chacun : journal, nombre de pas, scores à suivre) : avancement et heure de fin, note au fil des pas comparée à la version précédente, et comment le modèle est construit, en quelques lignes.
- **Banc d'essai de la transcription** : `opensmith-ingest bench` passe des morceaux dont on a la tablature écrite à la main dans la chaîne MP3 et compte les notes retrouvées (à 50 ms près, à chaque étape : brut, nettoyé, tablature), `--ablation` retire une à une les étapes du nettoyage ; `opensmith-ingest bench-view` affiche les runs dans le navigateur (couverture, tableau en clair, historique). Ce qu'il a déjà corrigé : la fusion des fragments ne fusionne plus deux attaques (elle coûtait 7 points), le vote des répétitions ne plante plus quand aucune octave ne fait le tiers.
- **Pourquoi une note est ratée** : le moteur dit, pour chaque note ou accord raté, ce que la guitare a joué autour : rien, la bonne note trop tôt ou trop tard (jusqu'à 350 ms), une autre note (trop haute, trop basse), ou un accord qui n'était pas le bon. Une note jouée si tard qu'elle arrive après la sanction l'explique à ce moment-là. L'autoroute l'écrit au-dessus des cordes (« Trop tôt », « Trop tard », « Trop haut », « Trop bas », « Mauvais accord ») ; l'écran de fin fait le compte.
- **Latence restante** : à la fin d'un morceau, si les notes arrivent toutes en retard (ou en avance) d'à peu près autant (au moins 20 notes, médiane ≥ 15 ms, écart interquartile ≤ 70 ms), l'écran de fin le dit et propose de compenser d'un clic.
- **Jugement plus juste pour une vraie guitare** (après comparaison avec feedBack et ChartPlayer) : notes étouffées, accords étouffés et harmoniques pincées jugés sur l'attaque seule (ils étaient toujours ratés : les parties rythmiques en sont pleines) ; harmonique naturelle jugée à la hauteur qu'elle sonne (case 7 : +19, case 5 : +24…) ; l'écart d'accordage du joueur appris sur les notes réussies (±45 cents) et une octave d'écart acceptée ; les accords tiennent compte de la compensation de latence (ignorée jusque-là : avec 150 ms, aucun accord n'était compté). Pas encore : accords à moitié joués, cordes qui sonnent encore sous la note suivante, notes tenues ; rien de tout cela n'a été essayé avec le câble et une vraie guitare.
- **Guitariste virtuel** : une guitare électrique de synthèse telle que le câble la transmet (`opensmith_dsp::guitar` : six cordes, une note à la fois par corde, les autres qui sonnent encore, médiator, notes liées, slides, bends, vibrato, palm mute, notes étouffées, harmoniques, cordes un peu désaccordées, ronflette et souffle) et un guitariste qui joue n'importe quelle partition à trois niveaux (`propre`, `moyen`, `débutant` : timing, notes oubliées, fausses notes, accords à une corde près, corde à vide frôlée, cordes laissées sonner), en notant tout ce qu'il a vraiment joué. `cargo run --release -p opensmith-session --bin opensmith-simulate -- --player all <partitions>` rejoue ses prises dans tout le moteur et dit, par sorte de jeu, ce que le jeu a compté ou refusé, et pourquoi. Sur 24 partitions, avant → après les réglages qu'il a guidés : joueur propre 83,7 → 88,8 % compté ; joueur moyen 72,4 → 81,5 % du bien joué compté et 68,9 → 86,9 % du mal joué refusé ; débutant 61,5 → 71,6 % et 74,7 → 85,2 %.
- **Détecteur de notes appris** (`engine-rt/dsp/src/notenet.rs`, `models/notenet/`) : un petit réseau (11 000 poids) dit, autour d'une attaque (40 ms avant, 120 ms après), quelles notes viennent d'être jouées ; il tourne dans le moteur en Rust, quelques millisecondes par appel, sur les mêmes caractéristiques qu'à l'entraînement (`notefeat`, spectre à trois cases par demi-ton). Entraîné en une heure sur 25 h de musique inventée par le compositeur (`composer` : accords grattés, arpèges, riffs, gammes, techniques) et jouée par le guitariste virtuel sur les notes enregistrées de Guitar-TECHS : aucun morceau de personne, des poids publiables. Le jeu s'en sert pour les accords (trois quarts des notes entendues, aucune note étrangère entendue nettement ; regardé le long du grattage) et pour les notes que le suivi n'a pas reconnues (cordes qui sonnent ensemble, liés doux), à l'attaque ou à l'heure de la note ; il tient compte du ralenti et de l'accordage du morceau. Résultats, avant → après : vrai jeu Guitar-TECHS 66,5 → 88,6 % du bien joué compté (95,1 % du mal joué refusé) ; en vraies notes sur 24 partitions, joueur parfait 77,5 → 95,4 %, joueur moyen 72,7 → 90,8 % (87,5 % du mal joué refusé ; accords à une corde près comptés 92,5 %), débutant 59,3 → 80,0 %.
- **Vrai jeu et vraies notes** ([Guitar-TECHS](https://guitar-techs.github.io), CC BY 4.0 : 5 h de guitare électrique en entrée directe, annotée corde par corde par un micro MIDI) : `opensmith-simulate --takes <prises>` juge du vrai jeu tel que joué, puis avec des erreurs écrites dans la partition (case voisine, 200 ms de décalage, note ajoutée où rien n'est joué) ; `--real-notes <prises>` fait jouer le guitariste virtuel sur 1 011 notes enregistrées (chaque corde à chaque case, normale, palm mute, vibrato, harmoniques) au lieu de la synthèse. Constat : le jeu compte 96 % des gammes et notes seules réelles, 93 à 98 % des techniques, mais un joueur parfait n'a que 65 % compté sur des partitions de morceaux jouées en vraies notes (89 % en synthèse, trop facile) et sur les accords et morceaux réels : accords non reconnus et suivi de notes trompé par les cordes qui sonnent ensemble (il rapporte la période commune d'un accord, une note très grave). C'est le prochain chantier, mesurable sans guitare. Les annotations du micro MIDI arrivent ~19 ms en retard et contiennent des notes fantômes (nettoyées à la conversion).
- **Accords** : trois quarts des notes suffisent (une corde oubliée passe), un peu de son étranger est toléré ; un accord non vu par le détecteur d'attaques n'est plus cherché à l'aveugle dans le son (un accord qui sonnait encore, joué trop tôt ou pas rejoué, était compté) mais seulement là où la guitare devient plus forte ; vérifié aussi jusqu'à 50 ms après l'attaque (le temps du grattage) et daté là où le son monte le plus. Le détecteur d'attaques voit les accords regrattés pendant que les précédents sonnent encore (aigus comparés à ce qui sonnait 8 à 25 ms avant) ; une note dont la hauteur n'apparaît que bien après l'attaque d'un accord est datée à sa propre montée de son.
- **Vitesse et latence** : ↑ ↓ en jeu règlent la vitesse de lecture de 25 à 150 % (pas sur scène ni en Score Attack) ; au ralenti, la partie est un entraînement : ni records, ni répétition, ni trophée. La compensation de latence est désormais appliquée en temps réel et non en temps du morceau (au ralenti, elle jugeait tout en avance : −33 ms à mi-vitesse avec 60 ms de latence). En fin de morceau, un décalage régulier est compensé tout seul (réglage « Ajuster la latence tout seul », activé par défaut), avec un bouton pour annuler.
- **Jouer sans réaccorder** : Réglages → Jeu → « Ma guitare reste accordée en » (Mi standard, Drop D…). Un morceau dont l'accordage est le même décalé d'au plus 5 demi-tons sur toutes les cordes (Mi bémol, Ré, Do# standard… ou Drop C/C# pour une guitare en Drop D), ou enregistré hors du La 440, est transposé au chargement (étirement sans changer la hauteur, celui du Loop Trainer, puis rééchantillonnage : même tempo, attaques à moins de 12 ms de leur place) et sa partition prend l'accordage de la guitare, mêmes cases. Environ 1 s pour un morceau de 4 min (rééchantillonnage à noyau tabulé, deux canaux en parallèle). Un message le dit au lancement.
- **Prises et rejeu** : avec Réglages → Jeu → « Enregistrer ma guitare pendant les morceaux », chaque partie jouée au câble est gardée (dossier `.takes` de la bibliothèque : le son de la guitare tel que le détecteur l'entend, la partition, le niveau de chaque phrase, le score en direct). `cargo run --release -p opensmith-session --bin opensmith-replay -- <prises>` les rejoue hors ligne dans tout le moteur (détecteur, vérificateur d'accords, session, jeu) sur des appels audio simulés et donne réussite, raisons des ratés et timing : de quoi régler la détection sur du vrai jeu. Vérifié : une prise rejouée retrouve les mêmes notes réussies qu'en direct, au timing près.
- **Plusieurs arrangements** : `song_chart.<partie>.json` à côté de `song_chart.json` dans le dossier d'un morceau ; la bibliothèque les range sous le même morceau, la fiche les propose (Lead, Rythmique, Combo…), chacun avec sa progression ; « Reprendre » rouvre le dernier joué. Pas encore la basse (l'autoroute a six cordes).
- **Guitare du morceau** : quand l'import a gardé la guitare à part (imports MP3, feedpak), elle voyage avec l'accompagnement et se règle à chaud dans le menu pause (« Guitare du morceau », muette par défaut) ; le lecteur temps réel la mixe sans commande ni allocation de plus.

## Étape 5 — Préparer la publication open source

- **Formats en plugins** : en dehors de l'audio et de Guitar Pro, les formats d'import viennent de plugins du convertisseur ; l'app apprend leurs extensions (`opensmith-ingest formats`).
- **Marques** : aucun jeu commercial n'est cité, sauf dans l'avertissement de marque du README ; le câble s'appelle « câble guitare USB » dans l'app. Aucun morceau commercial dans le dépôt.
- **App autonome** : une app compilée n'utilise plus le chemin du dépôt de la machine de build. Bibliothèque dans `~/Music/OpenSmith` ; le pipeline Python voyage dans les ressources de l'app et s'installe au premier import (copie dans le dossier de données de l'app puis `uv sync`, ~2 Go), étape « Installation du convertisseur » avec sa progression dans l'écran d'import. Une nouvelle version de l'app réinstalle ses sources. Signature et notarisation : [docs/macos-release.md](docs/macos-release.md) (entitlement micro pour le hardened runtime).
- **Anglais** : `src/i18n.ts` (`t()` / `tn()`), le texte français du code sert de clé au dictionnaire anglais (`src/locales/en`, ~860 entrées), `index.html` traduit au démarrage. Anglais par défaut sauf système en français ou joueur des versions précédentes ; sélecteur dans Réglages → Jeu. Un test vérifie que chaque texte affiché a son anglais. README principal en anglais, sa traduction dans [README.fr.md](README.fr.md), le guide détaillé en français dans [docs/guide.fr.md](docs/guide.fr.md).
- **Morceau de démo** : « First Riff » (OpenSmith), généré par `opensmith-ingest demo` (basse et batterie synthétiques, partition exacte de la guitare), 41 s, dans `app/demo` ; posé dans la bibliothèque au premier lancement (une seule fois), servi aussi par la version navigateur sans `out/`.
- **Licence** : GPL-3.0-or-later (`LICENSE`, déclarée dans les manifestes Cargo, npm et Python) ; composants tiers dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **CI** : GitHub Actions (`.github/workflows/ci.yml`) : tests Rust du moteur et de l'app (macOS), `tsc` + Vitest, pytest rapide (macOS, avec ffmpeg) ; `CONTRIBUTING.md`, modèles d'issues et de PR.

### Windows et Linux : ça compile, pas encore jouable

- **`cargo check` passe** pour `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu` et `aarch64-unknown-linux-gnu` (moteur et app), vérifié depuis le Mac sans machine Windows ni Linux (un `pkg-config` et un `llvm-rc` factices remplacent les bibliothèques du système visé). Rien n'a encore été édité en liens ni joué sur ces systèmes.
- **Horloge corrigée** : hors macOS, `host_now_ns()` comptait depuis son premier appel, sans rapport avec les horodatages de cpal : les notes auraient été jugées à côté. Elle lit QueryPerformanceCounter sous Windows (WASAPI) et CLOCK_MONOTONIC sous Linux (PipeWire).
- **Import sous Windows** : convertisseur (et son installation) dans son propre groupe de processus, sous la priorité du jeu, sans fenêtre de console, arrêté avec `taskkill /T` ; `uv.exe` trouvé ; le Python du convertisseur installé cherché dans `.venv\Scripts` ; bibliothèque dans le dossier Musique du système (aussi `XDG_MUSIC_DIR` sous Linux) ; icône Windows.
- **Convertisseur** : UTF-8 explicite (Windows écrit en cp1252, un titre accentué rendait le chart illisible) ; CUDA utilisé quand il est là.
- **Reste à faire** : latence sous Windows (cpal ne fait que du WASAPI partagé, 25 à 40 ms : il faudra le mode exclusif ou ASIO) ; sous Linux, l'hôte PipeWire de cpal, le choix du bon périphérique ALSA (le câble y apparaît plusieurs fois sous le même nom) et la 3D à 60 images/s dans la vue web.

### Import feedpak : les charts écrits à la main de feedBack

[feedpak](https://github.com/got-feedBack/feedpak-spec) est le format ouvert du projet feedBack (spec 1.x, CC0 + MIT) : un `manifest.yaml`, un JSON par arrangement, les stems audio. Lu sans reprendre de code de feedBack (`importers/feedpak.py`, commande `opensmith-ingest feedpak`).

- **Deux formes** : dossier `*.feedpak` ou archive zip (aussi zippée avec son dossier). Tout passe par le manifeste ; un chemin qui sortirait du pack est refusé ; `.jsonc` débarrassé de ses commentaires ; une version 2.x refusée avec un message clair.
- **Arrangement** : `--arrangement` (id ou nom), sinon lead, combo, rhythm, une autre guitare, la basse. Batterie, piano et parties en notation seule sont écartés.
- **Accordage** : décalages du manifeste d'abord (§5.2), sur E A D G B E ou E A D G pour une basse ; 7 et 8 cordes, basse 5 et 6 cordes ; une basse notée sur 6 décalages qui n'utilise que 4 cordes est une 4 cordes ; les octaves entières de `centOffset` déplacent les cordes, le reste devient le désaccord de l'enregistrement.
- **Difficulté** : un pack avec des niveaux par phrase les garde tels qu'écrits (plage de niveaux par note, haut de phrase prolongé jusqu'au maximum) ; les phrases au même contenu partagent un nom (difficulté dynamique, Loop Trainer). Un pack à un seul niveau reçoit les 5 niveaux générés comme pour Guitar Pro, doigté de l'auteur conservé.
- **Techniques** : hammer-on, pull-off, slide, bend (déjà en demi-tons), vibrato, palm mute, mute, harmoniques, trémolo, accent, tap ; sens du coup de médiator pour les accords ; notes « ignorées » écartées. Un accord joué autrement que sa forme reçoit sa propre forme.
- **Audio** : le stem `full` (le mixage complet), sinon les stems joués à l'ouverture, mixés ; WAV 48 kHz 16 bits. Pochette reprise si elle est là.
- **Durée** : celle de l'audio, jamais avant la dernière note ; la grille de temps est prolongée au même pas. Les packs publiés par feedBack ont des `duration` fausses dans les deux sens (l'hymne américain : 50,5 s annoncées, 78,3 s d'audio et des notes jusqu'à 69 s ; Für Elise : 185,8 s annoncées pour 128,3 s d'audio).
- **App** : `.feedpak` est un format intégré (pas un plugin : reconnu avant même l'installation du convertisseur), glissé sur la fenêtre ou trouvé dans un dossier de musique ; un dossier `*.feedpak` est un morceau, pas un dossier de stems. Badge « Chart » dans la bibliothèque.
- Vérifié sur les deux exemples de la spec (guitare, basse, accord, pochette, audio) et sur deux packs de démo de feedBack (The Star-Spangled Banner, 101 notes ; Für Elise en version guitare, 674 notes et 101 accords) : durée = audio, aucune note hors d'une phrase, 5 niveaux. Tests : `tests/test_feedpak.py` (24), `import.rs` et `lib.rs` (format reconnu, dossier pack = un morceau).

---

## Étape 4 — L'envie de rejouer

### La progression reste

- Chaque morceau garde : nombre de parties, meilleur score, meilleure précision, meilleure série, meilleure note, **le niveau de chaque phrase** (la difficulté dynamique reprend là où on l'a laissée) et **la maîtrise** : la part du morceau jouée à au moins 85 % de réussite, pondérée par la durée des phrases et par le niveau atteint (100 % = toutes les phrases au niveau maximum).
- App de bureau : `progress.json` dans le dossier des morceaux (écriture atomique). Mode démo : le stockage du navigateur.
- **La liste des morceaux devient une grille de pochettes** : barre de maîtrise, nombre de parties, meilleure note en pastille. Les morceaux en cours d'apprentissage passent en premier.
- **L'écran de fin annonce les records** : « Nouveau record de points ! », « Meilleure série battue ! », « Meilleure note ! », « Maîtrise 40 % → 52 % ».

### Loop Trainer

- On l'ouvre avec **L** pendant le morceau, depuis le menu pause, ou depuis l'écran de fin avec « Travailler un passage » (la phrase la moins réussie est déjà choisie).
- On choisit les phrases sur la carte du morceau (clic, Maj + clic pour une plage ; couleur = réussite jusqu'ici, or = maîtrisée), la vitesse de 40 à 100 % (raccourcis 50/75/100), et l'**Accélérateur** : +5 % après chaque passe à 90 % ou plus, jusqu'à 100 %.
- La boucle démarre sur une barre de mesure au moins 1,5 s avant le passage, pour se préparer, et repart 0,6 s après la fin du passage (+ la latence calibrée), le temps que la dernière note soit jugée. Seules les notes du passage sont affichées et jugées ; chaque passe est notée (« Passe 3 · 92 % », petites barres dans le bandeau LOOP TRAINER) et la difficulté dynamique continue de passe en passe.
- En jeu : ↑/↓ change la vitesse de 5 %, R recommence la passe ; le menu pause propose « Modifier le riff » et « Quitter le Loop Trainer ».
- Les passes à 100 % comptent pour la progression du morceau (niveaux, maîtrise), pas celles au ralenti.
- **Ralenti sans changer la hauteur** dans l'app de bureau : le moteur coupe l'accompagnement en segments de 73 à 90 ms joués tels quels, chacun recollé là où il prolonge le mieux le précédent (corrélation normalisée sur ±10 ms, comme SoundTouch), avec un fondu de 8 ms. L'horloge du morceau suit la vitesse : notes, jugement et autoroute ralentissent avec la musique. Le retour au début de la boucle se fait dans le callback audio, à l'échantillon près, avec un fondu de 12 ms. Rien n'est alloué dans le callback.
- Dans le navigateur (mode démo), le ralenti fait baisser la hauteur : seul le moteur natif la garde.

Mesuré (tests automatiques) :

| | Résultat |
|---|---|
| Sinus 440 Hz joué à 50 % et 75 % | l'énergie reste à 440 Hz (plus de 1000 fois celle de 220 / 330 Hz), niveau stable à ±1 dB |
| Clics toutes les 0,25 s, joués à 75 % | chaque clic entendu à moins de 30 ms de l'horloge du morceau |
| Retour au début de la boucle | plus grand saut d'échantillon 5·10⁻⁵ (sans fondu : 8·10⁻³) |
| Changements de vitesse 100 → 75 → 100 → 50 → 90 % | aucun clic (pente toujours sous 1,3 × celle du signal) |
| Guitariste simulé, phrase B en boucle à 75 % | passe 1 jouée : **17/17** ; passe 2 non jouée : 0/17 ; aucune note hors du passage annoncée |

### Mode Maître

- Pour une phrase maîtrisée au niveau maximum, les notes arrivent normalement puis **s'effacent entre 1,5 s et 0,3 s avant la ligne de frappe** : on la joue de mémoire. Un sustain tenu reste visible. Le HUD affiche « MAÎTRE » à côté de la phrase.
- Activé par défaut ; case à cocher dans Réglages → Jeu.

### Score Attack

- Depuis la fiche d'un morceau : quatre difficultés avec leur record, puis « Score Attack ». Le morceau entier se joue à un **niveau fixe**, sans difficulté dynamique :

| Difficulté | Notes jouées | Échec si une phrase est sous | Bonus |
|---|---|---|---|
| Facile | 40 % du morceau | 40 % | ×1 |
| Moyen | 60 % | 50 % | ×1,5 |
| Difficile | toutes | 60 % | ×2 |
| Maître | toutes, et elles s'effacent avant la ligne (mode Maître partout) | 70 % | ×3 |

- **Trois échecs et le morceau s'arrête** : chaque phrase jouée sous le seuil compte un échec (✕ dans le bandeau SCORE ATTACK, qui pulse en rouge au deuxième). Pas de saut, pas de Loop Trainer pendant la partie.
- **Fin de partie** : les points avec le bonus, « Nouveau record ! » ou la place obtenue, et les 5 meilleures parties de cette difficulté (points, précision, note, date). Une partie ratée n'est pas classée. Les phrases réussies comptent pour la maîtrise, mais les niveaux du mode apprentissage ne bougent pas. « Travailler un passage » recharge le morceau en mode apprentissage, dans le Loop Trainer.
- Vérifié dans le navigateur (mode démo) : partie Facile finie → 4 100 points, « Nouveau record ! » ; joueur automatique à 30 % en Difficile → échecs à 10, 19 et 27 s, arrêt et « Échec : 3 phrases ratées ».

### Tests ajoutés (étape 4)

| Fichier | Prouve |
|---|---|
| `audio/tests/player.rs` | hauteur et niveau gardés au ralenti, clics à l'heure de l'horloge, boucle sans saut et comptée, changements de vitesse sans clic |
| `audio/tests/rt_bridge.rs` | toujours 0 allocation dans les callbacks, avec ralenti et boucle |
| `session/tests/session.rs` | Loop Trainer au ralenti : passes jugées, notes hors du passage jamais annoncées, sortie de la boucle |
| `app/tests/progress.test.ts` | progression, records, maîtrise, passes à 100 %, début de boucle sur une barre, Accélérateur |
| `app/tests/game.test.ts` | jeu de démo limité au passage, niveaux gardés d'une passe à l'autre, résultats de passe |
| `app/tests/score-attack.test.ts` | trois phrases sous le seuil arrêtent la partie, niveau et bonus par difficulté, classement par difficulté, partie ratée non classée, niveaux d'apprentissage inchangés |

### Limites connues de l'étape 4

1. Le Loop Trainer n'a pas encore été essayé à l'oreille dans l'app de bureau avec la guitare : tests automatiques seulement.
2. À 50 %, le découpage en segments rend les attaques de batterie un peu « doublées » : c'est le prix d'un étirement dans le domaine temporel.
3. ~~Pas encore de Score Attack~~ : fait (voir plus haut). Pas encore essayé avec la guitare non plus.

---

## Étape 3 — L'application : autoroute de notes et boucle de jeu

### Ce qu'on voit

L'autoroute : le manche vu de face, les six cordes en bas de l'écran (Mi grave rouge **en haut** par défaut, option « cordes inversées » pour l'ordre tablature), les notes qui arrivent du fond à la hauteur de leur corde avec une tige jusqu'à leur case.

- **Notes** : gemmes aux couleurs strictes (rouge, jaune, bleu, orange, vert, violet), numéro de case dessus ; cordes à vide en barre sur toute la zone de la main ; **accords** dans un cadre avec leur nom, accord répété = cadre vide ; **sustains** lumineux (en biais pour les slides) ; techniques signalées (H, P, PM, ↑½…).
- **Repères** : lignes de temps et de mesure, début de chaque phrase avec son nom, zone de la main (anchors) surlignée y compris ses déplacements à venir, numéros de case en bas (zone de la main en blanc, prochaine case allumée dans la couleur de sa corde).
- **Caméra** : suit la zone de la main 0,45 s en avance et s'élargit pour garder en vue toute note proche hors zone ; mouvement amorti, identique à 60 et 120 images/s.
- **120 images/s** sur le M1 Max (bloom, particules, ~2000 éléments instanciés).

### Le jeu

- Note réussie : explosion d'étincelles (plus grosse si « parfait »), la corde vibre et s'allume ; un sustain tenu scintille. Note ratée : grisée.
- **Série** (grossit à chaque note, tremble quand elle casse), **multiplicateur ×1→×4** en anneau, points, précision.
- **Carte des phrases** en haut de l'écran : chaque phrase montre son niveau et devient verte/rouge selon le résultat.
- Messages : « Niveau supérieur ! », « Phrase maîtrisée ! », « Série de 50 ! », « Série perdue »… ; décompte 3-2-1 ; écran de résultats (note S/A/B/C/D, meilleure série, parfaits, niveau atteint) ; pause, recommencer, ±5 s.
- **Mode démo** dans le navigateur : la piste d'accompagnement joue, un joueur automatique (réussite réglable) joue avec les vraies règles du jeu, la difficulté dynamique monte ou descend sous les yeux.

### Menu d'accueil et bibliothèque

- **Menu d'accueil** : « Reprendre » relance le dernier morceau joué (pochette, maîtrise, meilleure note), puis Morceaux, Loop Trainer, Jouer librement, Accordeur, Ajouter des morceaux et Réglages. Dans le navigateur (sans moteur audio), les entrées qui demandent la guitare sont masquées.
- **Bibliothèque** : recherche instantanée sur titre, artiste et album, sans tenir compte des accents (`/` pour y aller) ; tri par derniers joués, titre, artiste ou maîtrise ; filtres par origine des notes et par accordage, avec le nombre de morceaux de chacun.
- **Origine des notes** sur chaque pochette : Tablature (Guitar Pro calée sur l'enregistrement), Chart (importé par un plugin), IA (transcrit depuis le MP3), Partition (tablature seule, sans audio). On voit d'un coup d'œil quels morceaux ont des notes exactes.
- **Fiche du morceau** (un clic) : grande pochette, album et année, accordage, durée, origine, meilleure note, record, meilleure série, parties jouées, maîtrise et une case par phrase colorée selon le niveau atteint ; puis Jouer ou Loop Trainer. Entrée joue le morceau choisi, Échap ferme la fiche puis revient au menu. Le Loop Trainer lancé depuis le menu demande d'abord le morceau, puis ouvre le choix des phrases.
- **Un seul écran de réglages** à onglets : Guitare (entrée, latence, volumes) et Jeu (cordes inversées, mode Maître, vitesse, niveau de départ).
- Vérifié dans le navigateur, en mode démo : recherche sur le début d'un titre → le morceau, filtre Tablature → 3 morceaux, fiche, Échap, Loop Trainer depuis le menu puis retour à la bibliothèque.

### Les vraies parties du morceau

- **Couplet, refrain, solo** au lieu de « Phrase A / B ». Les marqueurs des tablatures Guitar Pro (Verse 1, Pre Chorus, Guitar Solo…) deviennent les sections du chart, à l'heure de leur mesure dans l'enregistrement. Ce qui est joué avant le premier marqueur devient l'intro. Un marqueur rejoué par une reprise prolonge la même partie. Les phrases recommencent à chaque partie et n'en chevauchent jamais deux. Les sections en minuscules d'autres formats (verse, chorus, hook, noguitar…) suivent le même chemin.
- **En français, numérotées** : « Pre Chorus 2 » → Pré-refrain 2, « hook » → Accroche ; une partie qui revient sans numéro est numérotée (Break 1, Break 2). Les charts faits depuis l'audio seul gardent leurs lettres.
- **Partout** : le HUD (« Solo · 1/4 »), l'autoroute au début de chaque phrase, la fin de morceau et la fiche du morceau. Dans le Loop Trainer, les phrases sont rangées sous le nom de leur partie : un clic sur le nom prend toute la partie, Maj + clic étend le choix (« Couplet 1 → Refrain 1 · 0:15 – 1:45 · 306 notes »).
- Deux morceaux de test ont été recalés avec leurs marqueurs (Intro, Verse 1 → 5, Pre Chorus 1 → 3, Chorus 1 → 3, Guitar Solo ; Break, Interlude, Outro). Un troisième n'en a pas.

### Le matériel à l'écran : HUD, réglages audio, import visible

- **HUD matériel** en haut à droite des menus (`app/src/hw-hud.ts`) :
  - l'entrée écoutée, son voyant (vert : câble guitare USB, ambre : autre entrée, rouge : aucune) et la latence aller-retour mesurée en ms, relus toutes les 2 s ;
  - un mini vumètre segmenté en direct, avec maintien du pic ;
  - l'interrupteur **Guitare réelle / Démo auto** et le bouton **Tuner** ;
  - un clic sur l'entrée ouvre les réglages audio.
- **Démo auto dans l'app de bureau** : le juge du moteur (`Game::autoplay`) joue chaque note à son heure. Le morceau, l'autoroute et le public tournent comme en vrai ; maîtrise, records, trophées, répertoire et carrière ne comptent pas (la carrière est fermée pendant la démo).
- **Réglages en trois onglets** :
  - **Audio & guitare** : entrée et sortie CoreAudio (le moteur redémarre sur le périphérique choisi), gain d'entrée, seuil du noise gate (−90 à −20 dB, ou celui du canal), faders Master, Backing track et Guitare, canal de l'ampli ;
  - **Latence & calibrage** : calibration au clic, compensation, avance de l'affichage, **repère de synchro** (un clic à 1 760 Hz et un éclair calés sur l'horloge audio : on règle l'avance jusqu'à ce qu'ils tombent ensemble) et « Calibrer le niveau des micros » ;
  - **Jeu** : inchangé.
- **Import visible** :
  - « Importer un morceau (MP3 / GP) » au menu, bouton « Importer » dans Morceaux, glisser-déposer partout hors d'un morceau ;
  - chaque import montre ses étapes : 1. Séparation des pistes (Demucs htdemucs_6s) → 2. Tempo et notes (librosa, Basic Pitch) → 3. Doigté du manche (Viterbi) → 4. Bibliothèque, l'étape en cours allumée avec sa propre barre. Les bornes suivent les poids de `pipeline-ingest` (`progress.py`). Un .gp (ou un fichier d'un plugin) affiche sa lecture à la place des trois premières.
- **Un morceau en Drop C** : dans Morceaux avec sa puce Drop C et le filtre d'accordage ; « Jouer » ouvre l'accordeur réglé en Drop C, puis le morceau (vérifié jusqu'à la lecture dans le navigateur).
- Correction : la fiche d'un morceau de la bibliothèque s'écrasait en colonnes depuis le répertoire de carrière (règles `.song-card` partagées), désormais limitées au répertoire.
- Tests : autopilote (16 notes, toutes parfaites), étapes du pipeline par type de fichier et état, seuil du gate, volume master.

### Accordeur précis, câble pris dès qu'il est branché

- **Accordeur imprécis : mesuré, puis corrigé.**
  - Le mode accordeur réutilisait la hauteur du suivi de notes du jeu, calculée sur 43 ms pour la latence.
  - Sur des cordes pincées synthétiques (inharmonicité, micro chevalet, bruit), ses lectures (médiane de 5) s'écartaient de 1,6 à 5,3 cents (écart-type), jusqu'à 27 cents en pointe, pour une tolérance de ±3 cents.
  - Nouveau module `dsp::tuner` : fenêtre de 170 ms, période grossière par MPM, puis la même fenêtre filtrée sous 3,5× la fondamentale (sans déphasage), et la période remesurée sur autant de périodes que la fenêtre en contient.
  - Résultat : 0,1 à 0,4 cent d'écart-type, 2 cents au pire, de Do grave (Drop C) à Mi aigu. Les harmoniques aiguës, étirées et qui battent entre elles, faussaient la mesure.
- **Écran de l'accordeur** :
  - tête de guitare six-en-ligne, une clé par corde (clic pour la choisir), celle en cours qui pulse dans sa couleur, ✓ une fois accordée ;
  - grande note et fréquence au centième de hertz ;
  - un cadran qui étale les derniers cents (non linéaire, zone verte ±3 cents), l'aiguille lissée ;
  - « ↻ Tends » ou « Détends ↺ » allumé du bon côté ;
  - une barre de maintien : la corde est validée après 0,9 s dans la zone (hystérésis à ±4,5 cents), avec un carillon, puis la suivante ;
  - une lecture à l'octave de la corde en cours (fondamentale faible au micro) est ramenée à cette corde ;
  - seul, l'accordeur propose 10 accordages (E Standard, Drop D, Eb, D Standard, Drop C#, C# Standard, Drop C, C Standard, Open G, Open D).
- **Câble branché après le lancement** : l'app passe dessus toute seule (sauf si une autre entrée a été choisie à la main, et jamais en plein morceau), quitte la Démo auto pour la guitare réelle, et l'annonce. Un câble débranché puis rebranché est repris.
- **Mode libre muet, corrigé** : le câble guitare USB choisi par son nom dans « Entrée » était traité comme un autre périphérique, donc sans retour dans les haut-parleurs (anti-larsen). Il est maintenant reconnu comme le câble. L'historique d'entrée repart de zéro à chaque changement de périphérique (l'accordeur restait muet après un changement).
- **Les cordes bougent sur l'accueil** : hors morceau (menus, mode libre, réglages), chaque note jouée fait vibrer et briller sa corde avec une étincelle sur sa case (dans l'accordage du dernier morceau ou de l'accordeur). Un accord gratté secoue toutes les cordes, qui vibrent tant que la guitare sonne.
- Tests : précision de l'accordeur sur 7 cordes, silence et bruit ignorés, lectures de session stables à moins d'1 cent, note jouée hors morceau signalée une fois, placement d'une note sur le manche, octave ramenée, échelle du cadran, règle de bascule sur le câble.

### Menu pause : retour au menu et difficulté à la volée

- **Menu principal** dans la pause : le morceau s'arrête et le menu d'accueil s'ouvre (un concert de carrière en cours compte comme abandonné, comme avec « Morceaux »).
- **Difficulté** dans les réglages rapides de la pause :
  - choix : Auto (la difficulté dynamique, phrase par phrase) ou un niveau fixe sur tout le morceau, de « 1 · Débutant » à « 5 · Toutes les notes » ;
  - l'effet est immédiat dans le moteur (`Game::set_difficulty`), dès la phrase suivante : les phrases déjà à l'écran gardent leur niveau ;
  - revenir à Auto reprend chaque phrase au niveau appris ;
  - tant qu'un niveau est forcé, la partie compte (parties, records, maîtrise) mais les niveaux appris ne bougent pas ;
  - masquée en Score Attack, qui garde sa difficulté ;
  - chaque nouveau morceau repart en Auto, « Recommencer » garde le choix.
- Correction : le temps du morceau (« 0:36 / 3:32 ») ne passe plus sur trois lignes à côté de l'étiquette Maître.
- Tests : changement de difficulté en plein morceau dans le moteur Rust (dans les deux sens) et dans le jeu du navigateur ; niveaux appris conservés quand la difficulté est forcée.

### File d'import : un dossier entier, en fond, qui reprend

- **Un dossier part en entier** : glissé sur la fenêtre ou choisi avec « Importer un dossier… », tous ses fichiers audio et ceux des plugins (sous-dossiers compris) pas encore dans la bibliothèque passent dans la file, dans l'ordre. Un fichier déjà en file n'y entre pas deux fois.
- **On joue pendant ce temps** :
  - les morceaux importés apparaissent dans Morceaux au fil de l'eau (rafraîchi au plus toutes les 3 s, la recherche, la fiche ouverte et la position dans la grille restent) ;
  - la bibliothèque est lue hors du fil principal, et chaque fiche de morceau n'est relue que si son fichier a changé : la relire après chaque import ne fige plus le jeu ;
  - le convertisseur tourne à priorité réduite (`nice` 10), dans son propre groupe de processus.
- **La file reprend où elle en était** (`imports.json` dans la bibliothèque) :
  - fermer l'app arrête l'import en cours ; au lancement suivant, son dossier partiel est effacé et il repart, puis le reste de la file ;
  - après un plantage, un convertisseur resté orphelin est arrêté (s'il s'agit bien d'un import OpenSmith) ;
  - les échecs restent listés pour « Réessayer », la pause est gardée.
- **L'écran Importer** montre la file : « 13 / 254 », une barre d'ensemble, l'import en cours, les échecs, les 5 derniers morceaux arrivés, et les suivants par leur nom (« … et 236 autres en file »). Boutons Pause / Reprendre, Vider la file, Effacer les terminés.
- **Puce IMPORT** dans le HUD matériel tant que la file tourne (« IMPORT 13/254 » et sa barre) ; un clic ouvre l'écran Importer.
- Vérifié avec l'app compilée sur 6 archives : fermée par Cmd+Q en plein import, puis tuée (`kill -9`) en plein import, elle reprend chaque fois ; à la fin, 6 morceaux, aucun doublon, aucun convertisseur orphelin, plus de fichier de file.
- Mesuré sur ce Mac : une archive s'importe en 3,8 s, mais pèse **68 Mo** dans la bibliothèque (audio en WAV).
- Tests : reprise après fermeture en plein import (3 archives, ni reste ni doublon), pause gardée d'un lancement à l'autre, file vidée et échecs gardés, dossier mis en file sans ce qui est déjà importé ni doublon, fiche relue seulement quand elle change, résumé de file et lignes affichées pour 254 imports.

### Refonte visuelle « Stage rock » (sans toucher à l'audio ni au jeu)

- **Plus de fenêtres web centrées sur un flou** : chaque écran est un panneau ancré à gauche, pleine hauteur, au bord droit biseauté et souligné d'un liseré ambre lumineux ; la scène 3D reste nette à droite. Les écrans en jeu (pause, résultats, entracte, rappel) sont des blocs de HUD à gauche.
- **Direction artistique** (`app/src/theme.css`, chargée après `style.css`) :
  - fonds noir obsidienne et gris canon de fusil en verre fumé, avec un grain et des textures (métal brossé, fibre de carbone, tolex) ;
  - angles biseautés (`clip-path`) aux diagonales dessinées en métal, plus de coins arrondis ;
  - accents ambre lampe, or électrique, blanc incandescent, rouge overdrive et violet néon ;
  - polices locales (embarquées, sans réseau) : Chakra Petch pour les titres et boutons en capitales, Teko pour le titre et les notes, JetBrains Mono pour les chiffres.
- **Contrôles « hardware »** (`app/src/ui/controls.ts`) :
  - chaque `<select>` devient un sélecteur à flèches animé (`‹ SALLE DE CONCERT ›`, flèches du clavier) ;
  - chaque case à cocher, un interrupteur métallique avec son voyant ambre ;
  - chaque curseur, un fader cranté de console.

  Le contrôle natif reste caché dessous : le code le lit et l'écrit comme avant, le contrôle suit (événements, valeurs changées par le code, options remplacées). Cela vaut partout : réglages, pause, Loop Trainer, ampli, tri des morceaux.
- **Carrière** :
  - les dates sont des billets de concert avec un talon perforé, Public, Cachet et Setlist sur des lignes alignées (plus de chevauchement) ;
  - l'objectif et les jauges de public sont des vumètres segmentés vert, ambre, rouge.
- **Boutique** :
  - les guitares sont accrochées dans un râtelier de Custom Shop sur panneau perforé, avec un éclairage qui suit le pointeur, une étiquette de prix suspendue et un badge « Sur scène » à voyant ;
  - **survoler une guitare l'essaie sur le manche 3D**, net à côté du râtelier, puis revient à la guitare jouée.
- **La scène du concert** :
  - la foule en contre-jour : trois rangées irrégulières (hauteurs, carrures), des bras levés, plus nombreux quand la salle chauffe et qui pompent sur le temps, une masse sombre sans points blancs ;
  - un truss métallique et ses tours, des faisceaux qui balaient une brume volumétrique ;
  - dans les menus, la caméra respire doucement, puis s'arrête quand un morceau commence.

### Carrière, phase 3 : festivals, stades, rival, événements, label, exigence

- **Acte 4, les festivals** (5 000 à 20 000 personnes) :
  - le Festival de la Plage, les Dunes Électriques (8 000 fans), les Vieilles Pierres (12 000 fans) ;
  - **la date décisive, le tremplin** (15 000 fans) : il faut 75 % de public pour faire mieux que Les Vautours. Sinon la critique dit qu'ils partent en tournée à ta place.
- **Acte 5, les stades** (40 000 personnes et plus) :
  - le Grand Stade du Sud, le Stade de la Capitale (60 000 fans), le stade de Londres (120 000 fans) ;
  - **la dernière date** (180 000 fans, 90 000 personnes) : un public à 75 % et une note A font entrer le groupe au **Hall of Fame**.

  Ensuite, la carrière continue dans les stades. Les festivals et les stades ont leur enseigne et la bannière du groupe placées pour la caméra de jeu.
- **Le rival, Les Vautours** :
  - leurs fans s'affichent dans la carrière dès les bars ;
  - une semaine sur quatre, ils prennent une des dates (grisée, « Prise par Les Vautours »), jamais la seule ;
  - les musiciens démotivés partent chez eux, et on les affronte au tremplin.
- **Les événements** : environ une semaine sur trois (jamais les deux premières semaines), annoncés dans la carrière et sur la date concernée.
  - **Dénicheur dans la salle** : fans ×2 ce soir-là.
  - **Panne de courant** : set acoustique ; l'ampli passe en son clair dans l'app et le public démarre 8 points plus froid.
  - **La tête d'affiche annule** : une date en plus, à remplacer au pied levé, avec deux fois le public et le cachet mais un public 15 points plus froid.
  - **Batteur malade** : un remplaçant toute la semaine.
  - **Van en panne** : un concert de moins.
- **Le label (Disques Sauvages)**, à partir de l'acte 4 :
  - **Objectifs** : trois par saison, tirés d'une liste (salles à 80 %, rappels, notes A, concerts sans pause, fans de la saison, morceaux appris, album). Chacun rapporte 4 000 € (festivals) ou 6 000 € (stades) en fin de saison, et le bilan de saison le dit.
  - **Le studio** (créneau « Studio ») : chaque prise est une partie complète du morceau, sa précision fait la prise et la meilleure est gardée. Huit morceaux font un album.
  - **« Sortir l'album »** : les ventes suivent la qualité de l'album (au carré) et les fans (2 € et 0,15 fan par exemplaire). La discographie reste dans le studio.
- **L'exigence**, choisie à chaque « Nouvelle carrière », ou au tout début d'une carrière vierge :

  | Niveau | Règles | Gains |
  |---|---|---|
  | Rookie | première pause gratuite, accordages deux fois moins chers, sifflets au bout de 30 s | ×0,8 |
  | Pro | les règles de base | ×1 |
  | Légende | pauses et accordages plus chers, sifflets au bout de 12 s | ×1,25 |

- **Le Hall of Fame** : en tête de l'écran Trophées, avec le groupe, l'exigence, la saison et les fans. Il reste d'une carrière à l'autre.
- **Trois trophées de plus** : Plus forts que les Vautours, Premier album, Hall of Fame (19 en tout).

### Carrière : la semaine, le groupe et le matos

La suite de la gestion, après le répertoire.
- **La semaine en 3 créneaux** (barre « La semaine » dans la carrière, un point par créneau) :
  - un concert (un seul par semaine, deux avec le van) ;
  - une répétition du groupe (+0,15 de forme pour chaque morceau du répertoire, un peu de moral) ;
  - du repos (moral).

  « Semaine suivante » termine la semaine, les créneaux restants comptent comme repos. Une salle jouée dans la semaine ne revient pas dans les dates, les autres gardent leur public. Quand les dates ne sont plus jouables, la raison s'affiche sur le bouton.
- **Le groupe** (« Le groupe » dans la carrière) :
  - Les copains du garage au départ : Max à la batterie, Karim à la basse, Léa au chant. Chacun est noté sur 99 en précision, énergie et fiabilité, avec un moral.
  - **En concert** : la précision pèse sur fans et cachet (×1 à 50, ×1,12 à 90) ; l'énergie fait démarrer le public plus chaud (jusqu'à +8 points). Un moral bas use les deux.
  - **Les absences** : un musicien peu fiable peut manquer une date. Un remplaçant joue, ce qui est annoncé dans la setlist, au début du concert et dans le bilan.
  - **Le moral** :
    - il monte avec un public conquis à 70 % et avec le repos ;
    - il baisse après un concert froid, des sifflets ou un abandon, et après une semaine de concerts sans repos ;
    - sous 15 % en fin de semaine, le musicien part chez Les Vautours (le groupe rival) et un remplaçant prend sa place, ce que la carrière annonce.
  - **Le marché de la semaine** : un musicien par rôle, meilleur à chaque acte, avec un prix et un nombre de fans exigé (jusqu'à ~60 au garage, ~500 dans les bars, ~4 000 dans les clubs). Le recruter remplace celui qui tient ce rôle (achat confirmé d'un second clic).
- **Le matos** (dans la Boutique, avant les guitares), pour la carrière en cours :

  | Pièce | Prix | Effet |
  |---|---|---|
  | Deuxième guitare | 350 € | passer entre deux accordages ne refroidit plus la salle (la setlist et l'entracte le disent) |
  | Stand de merch | 500 € | environ 0,60 € par personne conquise à chaque concert |
  | Ampli à lampes | 700 € | public de départ +8 points |
  | Sono de tournée | 1 100 € | +15 % de public |
  | Le van | 1 500 € | deux concerts par semaine |

  Une nouvelle carrière repart sans matos, avec les copains du garage.
- **Le bilan du concert** ajoute le facteur « Groupe », les absents et les ventes de merch.

### Carrière : le répertoire et le dénicheur

La première brique de la gestion : le groupe ne joue sur scène que les morceaux qu'il connaît.
- **Le répertoire** (« Répertoire » dans la carrière) : chaque morceau appris a une **note sur 99**, comme une carte de joueur : 40 + 59 × (60 % de maîtrise + 40 % de forme). Les cartes sont dorées à 75 et plus, argentées à 65, bronze en dessous, avec la forme en flèche (↑ en forme, → correct, ↓ rouillé) et la dernière fois qu'il a été joué.
- **La forme** (0 à 1) tient deux semaines de carrière sans jouer le morceau, puis perd 0,12 par semaine.
  - Elle remonte de 0,35 à chaque partie complète hors concert (jeu libre, Score Attack, défi), de 0,08 par passe de Loop Trainer à pleine vitesse, et de 0,25 en concert.
  - Une setlist en forme multiplie fans et cachet par 1,1, une setlist rouillée par 0,85 (×1 à 60 % de forme). Le bilan du concert l'affiche (« Forme »).
- **Le dénicheur** propose chaque semaine 3 morceaux de la bibliothèque pas encore appris, assez longs pour un concert, les plus proches de la difficulté de l'acte (notes et accords par minute) : les plus faciles au garage, le milieu dans les bars, les plus durs dans les clubs. « Apprendre » ajoute un morceau au répertoire, à la forme 0,3 (note autour de 47).
- **La setlist** ne propose que le répertoire, avec la note et la forme de chaque morceau. Une date qui demande plus de morceaux que le répertoire n'en compte est grisée (« Il te faut 4 morceaux au répertoire »). Le rappel se choisit aussi dans le répertoire.
- **Au départ** : une nouvelle carrière commence avec les 3 morceaux les plus faciles de la bibliothèque (2 min 30 ou plus). Une carrière d'avant le répertoire reprend les morceaux qu'elle a joués en concert, complétés par les plus faciles. « Nouvelle carrière » repart d'un nouveau répertoire.

### Carrière, acte 3 : les clubs

Après le Bistrot Rock, la carrière passe dans les clubs : des salles de 300 à 800 places.
- **Cinq salles** :

  | Salle | Ouverte à | Morceaux | Cachet max | Particularité |
  |---|---|---|---|---|
  | Le Sous-Sol | dès l'acte | 4 | 400 € | |
  | L'Usine | 1 000 fans | 3 | 250 € | première partie de Neon Wolves |
  | Le Néon Club | 1 800 fans | 5 | 700 € | |
  | La Machine | 3 000 fans | 5 | 1 000 € | |
  | Le showcase du label (Paradiso) | 4 500 fans | 6 | 1 500 € | date décisive |

- **La première partie** : 600 à 750 personnes venues pour la tête d'affiche, un public qui part de 30 % au lieu de 50 %. Peu de cachet, beaucoup de fans à gagner. L'offre porte le badge « Première partie » et l'affiche dit « en première partie de Neon Wolves ».
- **Le showcase, date décisive** : un dénicheur de label dans la salle. Il faut un public à 60 % **et** une note A sur le concert (précision des morceaux, pondérée par leurs notes, à 92 % ou plus). Sinon la critique le dit : « le dénicheur est reparti sans signer ». Le gagner ouvre l'acte 4 (les festivals, annoncés pour la suite) et le trophée « Signé ! » (le 16ᵉ).
- **La note du concert** (S à D, sur la précision de la setlist) s'affiche maintenant dans chaque bilan de concert, à côté du public.
- **Les clubs à l'écran** : chacun a son enseigne au néon au-dessus du mur de LED, ses couleurs de LED et un public à sa taille (jusqu'à 270 personnes à L'Usine). Les affiches des clubs ont leur style, sombre avec une bande néon.
- Le défi de la semaine passe en Difficile ou Maître dans les clubs.

### Mode Carrière, phase 1 : du garage aux bars

« Carrière », en tête du menu : tu démarres dans un garage et tu montes de salle en salle, concert après concert.
- **La semaine** : une saison compte 12 semaines. Chaque semaine, les salles de l'acte proposent jusqu'à trois dates, toujours les mêmes pour une semaine donnée. On en joue une ou on passe la semaine. À la fin de la saison, un **bilan** attend en haut de la carrière : concerts, fans et cachets de la saison, meilleur concert, acte atteint.
- **La sauvegarde** : `career.json` dans le dossier de la bibliothèque, à côté de la progression (écriture atomique). La première version la gardait dans le stockage de la fenêtre : elle y est reprise une fois. Le mode démo du navigateur garde la sienne dans son stockage local.
- **Les deux premiers actes** : le garage (garage de Max, anniversaire, fête de quartier) puis les bars (Saloon, Zinc, Pub du port). Chaque salle s'ouvre à partir d'un nombre de fans et a son public, son cachet et sa longueur de setlist. La date décisive de l'acte (fête de fin d'année du lycée à 50 fans, Bistrot Rock à 500 fans) se gagne avec un public conquis à 60 % ou plus et ouvre l'acte suivant. L'acte 3 (les clubs) suit, voir plus haut.
- **La setlist** : les morceaux de la bibliothèque avec leur audio, triés par maîtrise, avec recherche. On choisit l'ordre ; la durée et les changements d'accordage sont signalés. Il faut au moins 2 min 30 de musique par morceau demandé : pas de concert d'extraits.
- **Le concert** : les morceaux s'enchaînent sans retour arrière (ni recommencer, ni saut, ni Loop Trainer), avec un entracte de 6 s qui donne la note et le public et annonce le morceau suivant. Une jauge de **public** suit la justesse des 16 dernières notes, lentement (constante de 2 s), de 0 % (55 % de notes justes) à 100 % (95 %). Un changement d'accordage la fait baisser de 12 points ; l'accordeur ne s'ouvre, dans l'app, qu'au premier morceau ou à un changement d'accordage. Un public sous 8 % pendant 20 s sort le groupe de scène. Chaque pause coûte 8 points de public à la reprise, et propose « Quitter le concert ».
- **Le bilan** : satisfaction (le public à la fin de chaque morceau, en moyenne), fans gagnés ou perdus (concert écourté), cachet (de 40 à 120 % de celui de la salle), une critique d'une ligne, et la bannière du nouvel acte. Chaque morceau joué compte aussi pour sa progression habituelle (records, maîtrise).
- **L'exigence** multiplie fans et cachet de ×0,6 à ×1,4 : les notes jouées par minute, au niveau joué, pondérées par la durée de chaque morceau (×1 à 120 notes par minute). Un morceau dense joué au complet rapporte plus qu'un morceau facile ou joué au niveau débutant.
- **La salle qui grandit** : chaque salle a son décor 3D (voir ci-dessous) : le garage de Max, le salon de l'anniversaire, la rue en fête, le gymnase du lycée, puis un bar à l'enseigne de la salle (SALOON, LE ZINC, PUB DU PORT, BISTROT ROCK), de plus en plus rempli. La jauge de public pilote l'ambiance.

### Défi de la semaine

Dans la carrière, sous l'objectif : un morceau de la bibliothèque, le même toute la semaine, à jouer en Score Attack.
- **Le morceau** est tiré de la semaine (saison et semaine) parmi les morceaux avec audio ; il change quand la semaine passe (concert joué ou semaine passée). La difficulté suit l'acte, en alternant d'une semaine à l'autre : Facile/Moyen au garage, Moyen/Difficile dans les bars, Difficile/Maître ensuite.
- **Les paliers** : fini sans trois phrases ratées, le Score Attack décroche le bronze à 60 % de précision, l'argent à 80 %, l'or à 92 %, jugés sur la précision affichée (91,7 % se lit 92 % et vaut l'or). La prime d'or : 40 € en Facile, 80 € en Moyen, 150 € en Difficile, 250 € en Maître ; le bronze en paie 40 %, l'argent 70 %.
- **Rejouer** : chaque palier se paie une fois par semaine, un meilleur palier paie la différence. La carte montre les paliers déjà atteints et, à l'or, « Or décroché ».
- **Après la partie** : la ligne du défi s'affiche dans le bilan du Score Attack (palier et prime, ou ce qui a manqué), « Carrière » remplace « Morceaux » et ramène à la carrière. Travailler un passage sort du défi.
- **Trophée** « Défi en or » (le 15ᵉ) pour un or.

### Ton groupe et l'album souvenirs

**Le groupe** : un nom (24 caractères) et un logo dessiné par le jeu, depuis le haut de la carrière (« Créer le groupe », puis « Modifier le groupe »).
- Le logo : un emblème (éclair, étoile, flamme, crâne, couronne, cœur, ailes ou aucun) au-dessus du nom, un lettrage (Métal, Rock, Punk, Gothique, Néon, chacun dans sa police du Mac) et des couleurs (Feu, Glace, Sang, Toxique, Néon, Or). L'aperçu suit chaque choix.
- **En fond de scène**, dans tous les modes :
  - garage : une toile sur la porte ;
  - petite fête : au mur du salon ;
  - fête de quartier : tendue au-dessus de la rue ;
  - gymnase : sous le plafond ;
  - bar : à côté de l'enseigne ;
  - club : en lumière sur le mur de LED ;
  - festival : entre les tours de projecteurs ;
  - stade : un tifo de lumières sur la tribune ;
  - salle de concert : en lumière au-dessus du public.

  La bannière vit avec la musique (temps, flashs).

**L'album souvenirs** : chaque concert laisse son affiche (« Album souvenirs » dans la carrière, et dans le bilan du concert).
- L'affiche porte le logo du groupe tel qu'il était ce soir-là, la salle, la date réelle, la setlist, le rappel, le public et un tampon (« Complet ! » à 85 % ou plus, « Sous les sifflets », « Écourté »).
- Deux styles : un flyer photocopié et scotché au temps du garage, une affiche de concert aux couleurs de chaque bar ensuite ; la date décisive a un double cadre doré. Un clic agrandit une affiche.
- Le groupe et l'album restent après « Nouvelle carrière » ; l'album garde les 300 dernières affiches.

**Correctif** : un rectangle noir apparaissait par moments au festival. Un rayon de projecteur lu par l'anticrénelage juste hors de son cône donnait `pow()` d'un nombre négatif (NaN), que le bloom étalait en blocs noirs. Les `pow()` des shaders sont maintenant bornés.

### Rappel et trophées

**Le rappel** : un public encore à 80 % ou plus à la fin de la setlist rappelle le groupe.
- Un écran « Rappel ! » (feux d'artifice derrière) propose trois morceaux : les mieux maîtrisés de la bibliothèque pas encore joués ce soir, sinon un de la soirée à rejouer, avec l'accordage s'il change. « Saluer et quitter la scène » (ou Échap) termine le concert sans rappel, sans pénalité.
- Joué jusqu'au bout, le rappel rapporte en plus : jusqu'à 60 % du cachet de la salle et un quart du public en nouveaux fans, selon le public à la fin du rappel et la densité du morceau. Il ne compte pas dans la satisfaction du concert. Quitter pendant le rappel revient à saluer.
- Le bilan du concert affiche la ligne du rappel (morceau, public, fans et cachet en plus).

**Les trophées** : 14, sur scène (carrière) et sur les morceaux (tous les modes sauf le Loop Trainer), dans « Trophées » au menu.
- Sur scène : Première scène, Une autre ! (un rappel), Salle en feu (public à 90 %), Pro de la scène (10 concerts sans une pause), Bienvenue dans les bars, Résident (Bistrot Rock), Premier millier (1 000 € de cachets), Ça arrive aux meilleurs (sorti de scène).
- Sur les morceaux : Sans faute (150 notes ou plus sans en rater une), Centurion (série de 100), Légendaire (S sur 50 notes ou plus), Solo parfait (toutes les phrases d'une partie Solo sans un raté), Maîtrise totale, Sans filet (Score Attack Difficile ou Maître sans un échec).
- Trois donnent une guitare que la boutique ne vend pas : **Relique** (bois usé jusqu'au clair sur les premières cases) pour Pro de la scène, **Lave** (roche noire fendue de lave qui pulse sur le temps) pour Salle en feu, **Platine** (nacre, chrome, diamants de glace) pour Solo parfait. La boutique les montre, grisées, avec le trophée qui les donne.
- Un trophée gagné s'annonce en haut à droite, avec la guitare qu'il donne. Ils restent avec les guitares après « Nouvelle carrière », comme les compteurs qu'ils suivent (concerts, concerts sans pause, rappels, cachets). Une carrière d'avant les trophées reçoit au chargement ceux qu'elle a déjà mérités (acte atteint, cachets de son historique), sans annonce.

### Boutique de guitares

Les cachets de la carrière achètent des guitares : l'aspect du manche sous les cordes, dans tous les modes de jeu (les cordes gardent leurs couleurs).
- **Neuf guitares**, de la série au rêve : Palissandre (de série), Érable 120 €, Ébène 250 €, Sunburst 400 €, Abalone 600 €, Flammes 900 €, Or massif 1 300 €, Néon 1 800 €, Galaxie 2 500 €.
- **Ce qui change** : la touche et la tête (veinage, dégradé sunburst, flammes peintes qui ondulent, filets de néon qui battent la mesure, nuit étoilée qui scintille), les frettes et les montants de frettes au-dessus du manche, les repères (points, blocs, ailerons de requin, étoiles, aucun, parfois lumineux), le sillet.
- **La boutique** : depuis la carrière (« Boutique de guitares »), chaque guitare dessinée sur sa carte avec son prix ; un achat se confirme d'un second clic et la guitare monte aussitôt sur scène. « Jouer avec » reprend une guitare déjà achetée ; Réglages → Jeu → Guitare aussi, hors de la boutique.
- **Pour de bon** : les guitares sont gardées dans `career.json` et restent après « Nouvelle carrière ». Une sauvegarde plus ancienne ou abîmée est remise en forme (guitares inconnues retirées, guitare jouée non achetée → celle de série).

### Décors 3D : du garage au stade

Derrière l'autoroute, de vrais lieux en 3D, construits au chargement avec des formes simples et des textures dessinées (rien à télécharger). Le joueur est sur une scène ; le public est en contrebas, jamais devant les notes qui arrivent.
- **Neuf décors** : Salle de concert (la scène abstraite d'avant), Garage (porte roulante entrouverte, ampoule qui grésille, voiture, établi), Petite fête (papier peint, guirlandes, boule à facettes, canapé, ballons), Fête de quartier (façades aux fenêtres allumées, guirlandes au-dessus de la rue, réverbères), Gymnase (parquet du terrain, néons, banderole « Bal de fin d'année », gradins pleins), Bar (comptoir et bouteilles éclairées, suspensions, bougies, enseigne au néon), Club (murs de LED en égaliseur, lyres sur une poutre), Festival (écrans, tours de projecteurs, drapeaux, 700 personnes, feux d'artifice), Stade (tribunes, 2 600 lumières de téléphones, tours d'éclairage, écrans géants, jets de flammes).
- **Tout suit la musique** : lumières et public sur le temps, l'énergie du public fait sauter la foule et allume les projecteurs un à un, les jalons de série déclenchent un flash, les notes ratées virent au rouge. Le décor s'assombrit pendant un morceau pour laisser l'autoroute lisible.
- **Au choix en jeu libre** : Réglages → Jeu → Décor. En carrière, la salle impose le sien.
- 110 images/s dans le stade, le décor le plus chargé (navigateur, Mac M).

### Pause, raccourcis, premier lancement

- **Pause** : pochette, titre, accordage et arrangement ; avancement dans le morceau avec la partie en cours ; points, précision, série et meilleure série. **Réglages rapides** sans quitter le morceau : volume de l'accompagnement (le mode démo l'applique aussi), volume de la guitare et canal de l'ampli (app de bureau), vitesse des notes.
- **`?`** ouvre la liste des raccourcis clavier, partout ; un morceau en cours se met d'abord en pause. Le menu et le HUD le rappellent.
- **Chargement** : la pochette et le titre du morceau avec un indicateur pendant le chargement de l'accompagnement (affiché seulement s'il dure plus de 150 ms).
- **Transitions** : chaque écran apparaît en fondu et son panneau monte légèrement (rien avec « réduire les animations » du système). Les textes les plus petits passent de 10–11 px à 11–12,5 px (pastilles, tuiles, fiche).
- **Premier lancement guidé** (app de bureau) : câble (détecté ou non), niveau d'entrée, latence, puis accordeur, une étape à la fois avec les réglages de guitare correspondants. Il s'affiche une fois ; Échap ou « Passer le guide » le referme pour de bon ; « Guide de démarrage » dans les réglages le relance.
- **Niveau de départ** : chaque cran vise une part des notes du morceau (30, 40, 60, 80 %, puis tout), quel que soit son nombre de niveaux (5 pour l'IA, jusqu'à 30 dans un chart écrit à la main). Le niveau le plus bas d'un chart très détaillé peut ne jouer que 3 à 8 % des notes (une note toutes les 6 à 15 s) : « débutant » y démarre maintenant au premier niveau qui joue 30 % des notes. Les charts de l'IA ne changent pas, leur premier niveau joue déjà un bon tiers des notes.

### Ajouter des morceaux depuis l'app

- **Glisser-déposer** : un MP3 (ou WAV, FLAC, M4A, Guitar Pro 3–5) lâché sur la fenêtre ouvre l'écran « Importer un morceau » et y est converti par le pipeline de l'étape 2, avec une barre de progression par étape (lecture, séparation de la guitare, transcription, tempo, tablature). On peut annuler, réessayer, puis cliquer sur « Jouer » une fois la conversion finie.
- **Dossier de musique** : un dossier lâché sur la fenêtre ou choisi avec « Choisir un dossier… » est retenu. L'app liste tous ses fichiers audio (sous-dossiers compris) et indique lesquels sont déjà convertis. On convertit un morceau d'un clic, ou tout le dossier avec « Tout convertir » (un morceau à la fois : la séparation occupe le GPU).
- Titre et artiste lus dans les tags du MP3, sinon dans le nom du fichier (« Artiste - Titre (Official HD Video) » → Titre, Artiste).
- La progression de Demucs vient de son propre callback (un point par segment de 8 s analysé) ; les étapes sont pondérées par leur durée réelle, donc la barre avance au même rythme que le travail.
- Vérifié dans l'application lancée sur ce Mac : bibliothèque vide → conversion du morceau démo lancée depuis l'interface → prêt en 18 s → la liste des morceaux se met à jour seule.

### Jouer avec une vraie guitare : réglages et accordeur

- **Réglages guitare** (Réglages → Audio & guitare et Latence & calibrage, depuis le menu) :
  - vu-mètre de l'entrée en direct, gain d'entrée réglable, et réglage automatique : 2 s de silence, puis 4 s de jeu fort. Le gain est choisi pour que les accords forts montent à −12 dBFS, sans que le bruit de fond dépasse −50 dBFS, sous les seuils de détection ;
  - **calibration de latence** : 4 clics d'annonce puis 12 clics sur lesquels on gratte une corde étouffée. Le retard médian devient la compensation appliquée à chaque attaque. Il couvre ce que les périphériques ne déclarent pas (Bluetooth, convertisseurs) et l'habitude du joueur ;
  - réglage manuel de la compensation et de l'avance de l'affichage, volume de l'accompagnement, volume de la guitare dans le casque (coupé d'office sans câble guitare USB pour éviter le larsen).
- **Accordeur avant chaque morceau**, réglé sur l'accordage du morceau : corde par corde, aiguille au cent, chaque corde validée après 0,6 s à ±3 cents. On passe à la corde suivante automatiquement, et une corde jouée hors de l'ordre est reconnue. « Jouer » s'active quand les six cordes sont justes ; « Passer l'accordage » reste possible. Il est aussi accessible seul, en accordage standard.
- Mesuré en simulation, avec les vrais détecteurs : un Do grave (Drop C, 65,4 Hz) lu à moins d'1 cent près, désaccordé de +15,7 ou −13,4 cents aussi. Une latence non déclarée de 25 ms est mesurée à +25,0 ms (12 coups sur 12). Une fois compensé, un joueur en retard de 40 ms retombe à une erreur moyenne nulle et ses coups redeviennent « parfaits ».
- Les paramètres sont gardés d'une session à l'autre et envoyés au moteur au démarrage.

### Mode ampli : jouer librement

« Jouer librement » (dans le menu d'accueil) : la guitare passe dans l'ampli sans morceau, et le son choisi reste pour les morceaux.
- **Quatre canaux** : Clair, Crunch, Lead, Métal. Chacun a sa saturation (plage de gain, asymétrie, coupe des graves avant saturation, médiums poussés, brillance) et ses réglages de départ ; leurs volumes sont équilibrés à 4 dB près.
- **Sept boutons** : Gain, Graves (120 Hz), Médiums (650 Hz), Aigus (2,8 kHz) à ±12 dB, Volume, Écho (380 ms, répétitions qui s'assombrissent) et Réverb (Freeverb), plus le noise gate. Ils se tournent à la souris (glisser vers le haut ou le bas), à la molette ou au clavier ; un double clic remet au milieu.
- **En direct** : les réglages partent vers le callback d'entrée par une file sans verrou ; tourner un bouton ne coupe rien et n'alloue rien (tests avec allocateur compteur).
- **Sortie** : enceintes du Mac, casque ou interface, choisis dans l'écran. La session rouvre le moteur audio sur le nouvel appareil en gardant le gain d'entrée, le retour guitare, l'ampli, le volume et la vitesse ; un morceau en cours s'arrête.
- **La note jouée** s'affiche avec son écart en cents, à côté du niveau d'entrée. Sans câble guitare USB, le retour reste coupé (le micro du Mac dans ses enceintes ferait un larsen) et l'écran le dit.

### Le look : la scène, le manche, les notes

- **Une salle de concert derrière l'autoroute** : ciel de nuit, brume violette à l'horizon, rampe de projecteurs qui balaient la scène, et le public en ombres chinoises (deux rangées de têtes et d'épaules) éclairé à contre-jour. Tout suit la musique et le joueur :
  - la lumière pulse sur chaque temps, plus fort sur le premier de la mesure, et le public saute ;
  - plus la série monte, plus il y a de projecteurs allumés et plus la salle s'embrase ;
  - une note ratée teinte la salle de rouge, une série de 10, 25, 50… la fait flasher.
- **Le manche** : une touche en palissandre (veinage procédural) sous les cordes, des frettes en métal, un sillet ivoire, des repères en nacre (doubles à la 12e et à la 24e).
- **Les notes** : gemmes arrondies et brillantes (reflet spéculaire et liseré de lumière). Sur les accords, le numéro du doigt à poser est affiché dans une pastille ; sur les notes seules, le numéro de case est écrit au pied de la tige, sur l'autoroute, dans la couleur de la corde. Les bends sont signalés par une flèche courbe avec leur ampleur (½, 1, 1½).
- **Où poser les doigts, sur le manche** : une lumière sur la corde, à la case des trois prochaines notes. Elle est vive pour la suivante et plus sombre pour les deux d'après, et chacune grandit en approchant. Les notes d'un même accord partagent leur rang, et l'accord suivant montre ses numéros de doigts sur le manche. La corde de la prochaine note s'allume et s'épaissit tandis que les autres s'atténuent ; une corde à vide ne fait que s'allumer. Sur l'autoroute aussi, la note suivante est la plus vive.
- **Caméra** : plus basse, derrière le manche, qui reste en bas de l'écran avec ses numéros de case ; la tête de la guitare se voit en position basse, et l'image s'incline un peu quand la main monte vers les aigus.
- **Autoroute centrée sur la main** : dalles sombres quadrillées par les frettes sous les cases de la main ; ailleurs, le sol et les temps restent discrets. Les numéros de case sont repris à mi-distance sur l'autoroute, en orange pour la main. Les cadres d'accords sont légers, limités aux cases de l'accord, avec leur nom en haut à gauche. La salle s'assombrit pendant un morceau.
- **Les pochettes** : l'image du MP3 (pochette d'album ou vignette de vidéo) est extraite à la conversion, recadrée en carré 512 px. Elle apparaît dans la liste des morceaux, l'accordeur, le HUD et l'écran de fin. Sans image, une pochette est générée avec les initiales du titre sur un dégradé propre au morceau.
- **L'écran de fin** : pochette et titre, la note (S, A, B, C ou D) qui arrive en grand avec sa couleur, un verdict (« Légendaire ! », « Excellent ! »…), une barre par phrase (hauteur = niveau joué, couleur = réussite), les compteurs qui défilent, et un feu d'artifice au-dessus du manche pour une note S, A ou B.

### Des tablatures plus propres

Trois traitements, avant le calcul des doigtés, pour que la tablature ressemble à celle qu'un humain écrirait :
- **Vote entre les répétitions** : les répétitions d'une même phrase (reconnues au son) votent note par note, au douzième de temps près. Une note retenue par au moins la moitié des répétitions est gardée ; les autres sont du bruit. Pour une phrase jouée deux fois seulement, une note présente dans une seule répétition est gardée si elle est assez forte (au moins 0,75 fois la note médiane de la phrase). Toutes les répétitions reçoivent ensuite les mêmes notes, au tempo de chacune, et le même doigté (celui que la majorité avait reçu).
- **Main stable** : la position de la main ne change que quand une note sort de la zone. On choisit à chaque fois la position qui tiendra le plus longtemps (le moins de déplacements possible). Un écart de moins de 0,6 s est absorbé en élargissant la zone, jusqu'à 6 cases.
- **Accords nettoyés** : les harmoniques empilées loin au-dessus de la basse disparaissent, puis, si l'accord n'a pas de nom, ses notes les plus faibles une à une jusqu'à ce qu'il en ait un. La basse reste toujours.

| | Morceau A | Morceau B | Demo Rock |
|---|---|---|---|
| Ressemblance entre répétitions | 0,10 → **1,0** | 0,04 → **1,0** | 0,70 → **1,0** |
| Formes d'accords différentes | 44 → **23** | 33 → **11** | 16 → **8** |
| Accords sans nom | 5 → **0** | 1 → **0** | 0 → 0 |
| Changements de main par minute | 7,1 → **5,7** | 5,6 → **4,5** | 6,3 → **1,6** |
| Positions tenues moins d'une seconde | 10 → **1** | 0 → 0 | 1 → **0** |

Contrôle avec vérité terrain (le morceau synthétique) : précision 0,89 → **0,96**, rappel 0,83 → 0,84, **F1 0,86 → 0,90**. Le seuil de 0,75 a été choisi sur ce morceau : sans vote, F1 0,876 ; seuil 1,0 : 0,861 (trop de vraies notes perdues) ; seuil 0,5 : 0,888 mais précision 0,87. Pour un jeu, une fausse note injouable gêne plus qu'une note absente.

`opensmith-ingest rechart <dossiers…>` recalcule la tablature d'un morceau déjà converti, sans refaire la séparation (la transcription est gardée dans `transcription.json`) ; les morceaux de `out/` ont été recalculés, l'ancienne tablature est gardée dans `song_chart.previous.json`.

### Des notes vérifiées sur la piste guitare (`stem.py`)

Basic Pitch entend bien les hauteurs, mais il faut le contrôler avec la piste guitare elle-même :
- **Attaques section par section** : le seuil suit le volume des 4 dernières/prochaines secondes. Avant, un seul seuil pour tout le morceau : l'intro en son clair écrasait la partie saturée du morceau B (0,2 attaque/s trouvée au lieu de 2,3) et 86 % de ses notes étaient jetées.
- **Octave vérifiée par YIN** : une note grave passée par un ampli a souvent une fondamentale 20 à 30 dB sous son octave, et Basic Pitch écrit l'octave du dessus. YIN mesure la période de l'onde, que la fondamentale faible ne trompe pas. Une note ne descend que d'une octave, jamais sous Mi2 (ou sous la note la plus grave du morceau), et pas quand la note entendue sonnait déjà avant l'attaque (corde à vide qui résonne sous un arpège, basse qui déborde).
- **Doublons fusionnés** : une note doublée à l'octave dans une ligne de notes seules devient une note ; la même note répétée à moins de 0,1 s est un fragment ; les répétitions d'une phrase votent sur l'octave d'une note seule (la plus grave qu'au moins un tiers d'entre elles entend).
- **Notes dans le silence supprimées** : à plus de 40 dB sous le niveau habituel de la piste, ce n'est pas de la guitare (Basic Pitch normalise son entrée et transcrit le moindre résidu). Les notes que le vote recopie d'une répétition à l'autre repassent par ces contrôles.
- **Accordage revu** : pour D, C# et C, drop ou toutes les cordes baissées ? Les power chords sur la corde grave indiquent un drop ; sinon c'est la corde à vide suivante qui trahit l'accordage (la quinte en drop, la quarte en standard). Il faut aussi 1,5 % des notes (au lieu de 0,5 %) pour qu'une note grave compte : la basse qui déborde dans la piste n'abaisse plus l'accordage. `rechart --retune` refait la détection.

Mesures avant → après :

| | Avant | Après |
|---|---|---|
| Morceau synthétique (vérité exacte) : précision / rappel / F1 | 0,90 / 0,82 / 0,86 | 0,94 / 0,84 / **0,89** |
| Morceau B : notes de l'intro sur les notes du riff (D2 D#2 E2 G2 A2) | 18/57 (32 %) | 42/70 (**60 %**) |
| Morceau B : fenêtres de 8 s où la guitare joue sans aucune note | 11/26 | **0/26** |
| Morceau B : accordage | Drop D (faux) | **D Standard** |
| Morceau A : notes là où la guitare se tait / notes doublées à l'octave | 3 / 20 | **0 / 10** |
| Nothing Else Matters, intro contre la tablature humaine (F1) | 0,60 | 0,59 |
| Nothing Else Matters, solo contre la tablature humaine (rappel / F1) | 0,48 / 0,39 | 0,54 / 0,39 |

Sur un arpège en jeu laissé sonner (Nothing Else Matters), la transcription reste à ~60 % : plusieurs cordes sonnent en même temps et aucun contrôle de hauteur n'est fiable. Les corrections ont été réglées pour ne rien y casser (une première version faisait descendre les notes sous la corde de Mi qui résonne : F1 0,44 et accordage Drop C). Pour une partition exacte, il faut une tablature humaine calée sur l'audio.

### Tablatures humaines calées sur l'enregistrement (`align.py`)

Pour une partition exacte : un fichier Guitar Pro posé à côté du MP3, avec un nom qui dit le même morceau (`artiste-titre.gp3` pour `Artiste - Titre (Official Music Video).mp3`). La conversion garde alors les notes, le doigté et les mesures de la tablature, et les place aux instants de l'enregistrement :
- **Calage global** : la tablature et la piste guitare deviennent des chromas (énergie des 12 notes dans le temps) ; un alignement dynamique (DTW) trouve où la tablature se trouve dans le morceau (une intro de clip est sautée). Le tempo peut varier localement entre ×0,5 et ×2, et le coût d'un chemin est compté par seconde de tablature : sans ça, toute la tablature du morceau D s'écrasait sur la dernière minute du morceau.
- **Calage fin** : chaque note se recale sur les notes de même hauteur entendues autour d'elle (médiane sur ses voisines), puis sur sa propre attaque.
- **Garde-fou** : une tablature dont moins de 15 % des notes sont entendues, ou au tempo invraisemblable, n'est pas de ce morceau ; la conversion revient à la transcription et `retab` refuse avec la raison.
- **Dans l'app** : le dossier de musique affiche « avec tablature » ; un morceau déjà converti reçoit « Appliquer la tablature » (commande `retab`, la partition précédente reste dans `song_chart.previous.json`, la tablature utilisée est notée dans `tab.json`).

| | Morceau B | Morceau C | Morceau D |
|---|---|---|---|
| Notes de la tablature entendues par la transcription | 49 % | 63 % | 39 % |
| Première note placée / attaque réelle | 1,0 s / 0,99 s | — | — |
| Tempo de la tablature / mesuré après calage | 120 / 120,6 BPM | 96 / 99 BPM | 168 / 169 BPM |
| Une autre tablature sur ce morceau | 0 à 1 % entendues | | |

Test synthétique (intro de 3 s absente de la tablature, 6 % plus lent, dérive de tempo) : **écart médian < 20 ms**, 90 % des notes à moins de 50 ms.

Ces trois tablatures calées donnent enfin une vérité terrain sur de vrais morceaux. La transcription automatique seule, comparée note à note (même hauteur, ±0,1 s) :

| F1 | Avant les contrôles de la piste guitare | Après |
|---|---|---|
| Morceau B | 0,15 | **0,19** |
| Morceau C | 0,14 | **0,15** |
| Morceau D | 0,08 | **0,10** |

L'IA seule retrouve donc 10 à 20 % des notes d'une tablature humaine sur un vrai morceau (précision ~25 %, rappel 6 à 15 %) : la tablature humaine calée reste la seule voie vers une partition juste.

### D'autres formats par des plugins

`opensmith-ingest` charge les commandes des plugins installés dans son environnement (point d'entrée `opensmith_ingest.commands`). Chaque commande dit quelles extensions de fichiers elle importe ; `opensmith-ingest formats` les liste (JSON `{extension: commande}`). L'app les demande au démarrage, puis à chaque ouverture du choix de fichiers : un plugin installé, ses fichiers se glissent dans la fenêtre et sont repérés dans le dossier de musique comme des MP3. L'installation du convertisseur garde les plugins (`uv sync --inexact`). Leurs morceaux ont l'origine « Chart » dans la bibliothèque : notes écrites à la main pour l'enregistrement.

Ce que le jeu garde pour les charts déjà calés sur leur enregistrement :
- **Accordages nommés** comme les guitaristes : E Standard, Eb Standard, Drop D, Drop C#, Open G, DADGAD… au lieu de « Standard » / « Custom ».
- **Enregistrements décalés du La 440** (`tuning.cents` du chart, jusqu'à +84 cents) : l'accordeur règle les cordes sur l'enregistrement et le moteur retire le décalage avant de juger les notes et de vérifier les accords. Sans ça, une guitare accordée 84 cents plus haut sonne comme le demi-ton suivant : 0 % de notes reconnues, contre 97,3 % avec (test de session).
- **Sections** : intro, verse, chorus, hook, riff, solo, noguitar… s'affichent traduites (Intro, Couplet, Refrain, Accroche, Riff, Solo, Sans guitare).
- **Vérité terrain pour l'IA** : comparé à un chart de référence écrit à la main (morceau A), le chart transcrit par l'IA depuis le MP3 trouve 15,6 % des notes, et 42,5 % de ses notes sont justes (F1 22,8 %). La tablature Guitar Pro du morceau D calée sur l'enregistrement fait F1 37,7 % (56 % sur les seules attaques).

Tests : `tests/test_plugins.py` (commande ajoutée par un plugin, formats listés pour l'app), `app/src-tauri/src/import.rs` (formats d'un plugin appris, archive de plusieurs morceaux arrivée en un dossier par morceau), `session/tests/session.rs` (guitare accordée 84 cents plus haut, jugée juste).

### Le moteur derrière (`engine-rt/session`)

- Le callback de sortie joue la piste d'accompagnement à l'échantillon près (décompte, pause, saut, fin) et publie l'**horloge du morceau** : quelle trame atteint les oreilles à quel instant (horloge hôte).
- Le callback d'entrée date chaque échantillon de guitare à sa capture et en garde une copie brute pour la vérification d'accords.
- **Latence des flux** : cpal ne compte que la latence du périphérique et sa marge de sécurité. Le moteur lit en plus celle des flux CoreAudio (`kAudioStreamPropertyLatency`), comme le font les navigateurs, et la relit toutes les 500 ms (un casque branché change la sortie par défaut). Sur les haut-parleurs du MacBook, c'est 14,4 ms de plus côté sortie ; un casque Bluetooth en ajoute bien davantage. Avant, l'horloge du morceau avançait d'autant : les notes arrivaient avant leur musique.
- Toutes les 2 ms, la session replace chaque attaque **à l'endroit du morceau que le joueur entendait** quand il a joué : les latences d'entrée et de sortie, et la dérive entre les deux horloges, sont compensées par construction. Les accords sont vérifiés sur l'audio de leur propre attaque (ou cherchés dans toute la fenêtre si le grattage n'a pas été repéré).
- Chiffres en simulation (sortie 12 ms de latence, entrée 3 ms, horloges décalées de 60 ppm, morceau entier) : **97,3 % reconnus au niveau 4, erreur de timing moyenne −0,5 ms** (pire 8,5 ms) ; un joueur 60 ms en retard est mesuré à +60 ms (±1 ms) ; 160 ms en retard : raté.
- Sur les vrais périphériques de ce Mac : l'horloge avance de 1,5045 s pour 1,5 s réelle, aller-retour 9,21 ms, 0 coupure.
- La lecture et l'horloge n'allouent jamais dans les callbacks (allocateur compteur), y compris en changeant de morceau.
- **Application de bureau lancée sur ce Mac** : bibliothèque lue, Demo Rock chargé (accompagnement de 37,9 s décodé), joué jusqu'au bout son coupé, phrases jugées et fin du morceau remontées jusqu'à l'interface (`OPENSMITH_AUTOPLAY=demo/chart/song_chart.json OPENSMITH_VOLUME=0`).

### Tests ajoutés (étape 3)

| Fichier | Prouve |
|---|---|
| `audio/tests/player.rs` | lecture à l'échantillon près, décompte silencieux, saut daté par génération, pause, fin, horodatage des échantillons d'entrée, copie brute continue |
| `game/tests/restart.rs` | chaque note renvoie à son événement du chart ; reprise à un instant : rien avant n'est jugé, les niveaux appris restent |
| `session/tests/session.rs` | morceau entier joué par un guitariste simulé derrière deux périphériques réalistes ; retard mesuré ; saut |
| `session/tests/hardware.rs` (`--ignored`) | horloge du morceau sur les vrais périphériques |
| `app/tests/*.test.ts` (Vitest, 17) | géométrie de l'autoroute, ordre des cordes, caméra, horloge lissée, règles du jeu de démo, vue du jeu, textes des conversions |
| `app/src-tauri/src/import.rs` (3 + 1 `--ignored`) | file de conversion : progression, échec expliqué sans fichiers laissés, annulation en cours ou en attente ; conversion réelle d'un MP3 par le pipeline |
| `pipeline-ingest/tests/test_import_cli.py` | titre/artiste depuis le nom du fichier ou les tags, progression qui n'avance que vers l'avant, sortie JSON ligne par ligne, erreur expliquée |
| `session/src/calibration.rs` + `session/tests/session.rs` | accordeur au cent sur une corde de Drop C, latence non déclarée mesurée sur les clics, compensation qui recentre un joueur en retard |
| `audio/tests/player.rs` | gain d'entrée vu par la détection et le vu-mètre, volume du retour guitare changé à chaud, retour coupé sans câble |
| `app/tests/guitar.test.ts` | choix de la corde jouée, conseils (tends/détends), gain suggéré par rapport au bruit de fond |
| `dsp/tests/amp.rs`, `rt_safety.rs` | quatre amplis bornés et de volume voisin, plus de gain = plus d'harmoniques, graves et aigus à ±12 dB, écho 380 ms qui s'éteint, queue de réverb ; aucune allocation en tournant les boutons |
| `audio/tests/player.rs`, `rt_bridge.rs`, `session/tests/session.rs` | ampli changé pendant qu'on joue ; changement de sortie qui garde réglages et ampli |
| `app/tests/amp.test.ts` | canaux et réglages de départ, réglages sauvegardés remis dans les bornes, affichage 0 à 10 |
| `app/tests/library.test.ts` | origine des notes de chaque morceau, recherche sans accents sur titre, artiste et album, quatre tris, filtres par origine et accordage, niveau maîtrisé par phrase (nommé par sa partie) |
| `app/tests/sections.test.ts` | parties nommées en français depuis les tablatures et les charts, numérotation des parties qui reviennent, nom de chaque phrase (« Couplet 1 · 2/2 »), lettres gardées sans noms |
| `pipeline-ingest/tests/test_importers.py` | marqueurs Guitar Pro devenus sections, intro avant le premier, reprise qui prolonge la partie, phrases recommencées à chaque partie |
| `app/tests/game.test.ts`, `welcome.test.ts` | niveau de départ réparti sur les niveaux du morceau ; ce que le guide dit du câble |
| `app/tests/career.test.ts` | salles ouvertes par les fans, mêmes dates toute la semaine, cachet et fans selon le public, date décisive et acte suivant, concert écourté, sauvegarde abîmée ; jauge de public qui monte et descend, au même rythme à 60 et 120 images/s, sortie de scène, refroidissement à l'accordage ; exigence selon les notes par minute, setlist minimale, bilan de saison, noms de salles dans les phrases ; boutique : guitare de série, prix croissants, achat avec les cachets, rien de trop cher ni de déjà acheté, guitares gardées par une nouvelle carrière, sauvegarde réparée ; rappel payé en plus selon son public, hors satisfaction, compteurs de concerts, de concerts sans pause et de rappels, compteurs d'une ancienne sauvegarde tirés de son historique, guitares à gagner pas en vente ; groupe nommé (nom coupé, nom vide = pas de groupe, choix inconnus remis par défaut), affiche de chaque concert avec le groupe de ce soir-là même renommé ensuite, groupe et album gardés par une nouvelle carrière ; acte 3 : clubs ouverts après les bars avec le Sous-Sol d'abord, première partie, showcase gagné seulement avec le public et la note A (critique du dénicheur sinon), précision du concert pondérée par les notes ; défi de la semaine : même morceau toute la semaine quel que soit l'ordre de la bibliothèque, difficulté selon l'acte et la semaine, paliers bronze/argent/or sur la précision affichée, échec sans prime, chaque palier payé une fois et le suivant à la différence, trophée Défi en or |
| `app/tests/phase3.test.ts` | tremplin perdu ou gagné contre Les Vautours, dernière date et Hall of Fame (gardé par une nouvelle carrière), événements une semaine sur trois et jamais au début, dénicheur (fans ×2), panne (public plus froid), tête d'affiche remplacée (public et cachet ×2, date à part), batteur malade, van en panne, date prise par le rival, label signé à l'acte 4 et ses trois objectifs, prime de fin de saison, prises de studio et sortie d'album, gains selon l'exigence |
| `app/tests/management.test.ts` | semaine en 3 créneaux (un concert, deux avec le van, salle jouée retirée des dates sans changer les autres), fin de semaine automatique ou demandée avec repos, répétition du groupe ; matos acheté une fois, sono, merch, ampli, première partie ; précision et énergie du groupe, moral qui use, absences toujours les mêmes pour une date, moral après concert et après semaine, départ chez le rival et nouvelle, marché meilleur et plus cher à chaque acte, recrutement selon argent et fans, groupe relu d'une sauvegarde ; accordages avec une ou deux guitares |
| `app/tests/repertoire.test.ts` | note sur 99, forme tenue deux semaines puis en baisse, répétition depuis la forme du jour, facteur de forme sur fans et cachet, répertoire de départ (morceaux joués en concert, sinon les plus faciles assez longs), dénicheur près de la difficulté de l'acte et changeant chaque semaine, concert qui paie mieux une setlist en forme et remet ses morceaux en forme, répertoire relu d'une sauvegarde |
| `app/tests/trophies.test.ts` | identifiants uniques, trois trophées qui donnent une guitare, morceau sans faute (150 notes au moins), série de 100, note S sur 50 notes, maîtrise totale, Score Attack difficile sans échec, solo parfait trouvé par ses phrases (silences ignorés), trophées de concert et de carrière, trophée gagné une seule fois avec sa guitare |
| `pipeline-ingest/tests/test_consensus.py` | vote (note manquée rendue, fantôme retiré, changements de tempo), doigté unifié, main stable sur un écart court, accords nettoyés |
| `pipeline-ingest/tests/test_pipeline_e2e.py` (lents) | répétitions écrites à l'identique, une seule position de main pour le morceau synthétique |
| `pipeline-ingest/tests/test_stem.py` | YIN entend Mi2 malgré une fondamentale 30 dB sous l'octave ; attaques trouvées dans une partie saturée après une intro claire (un seuil global en rate plus de la moitié) ; silence |
| `pipeline-ingest/tests/test_transcription.py` | riff écrit une octave trop haut ramené, doublons d'octave fusionnés, corde à vide qui résonne sans effet sur les notes suivantes, accords et octaves laissés tels quels, notes dans le silence et fragments retirés |
| `pipeline-ingest/tests/test_consensus.py`, `test_tunings_and_tempo.py` | vote sur l'octave entre répétitions ; D Standard reconnu face au Drop D, Drop C sans accords, basse qui déborde sans effet |
| `pipeline-ingest/tests/test_align.py` | tablature calée malgré intro, tempo et dérive (écart médian < 20 ms) ; tablature d'un autre morceau rejetée ; tablature trouvée par le nom du morceau ; `retab` sur un morceau converti |
| `app/src-tauri/src/import.rs` | tablature trouvée à côté de son MP3 ; tablature appliquée dans le dossier du morceau, qui survit à un échec |

### Limites connues de l'étape 3

1. **Toujours pas testé avec le vrai câble et une vraie guitare.**
2. La calibration mesure la latence totale (entrée + sortie + joueur) : un décalage propre à l'écran se règle à la main (« Avance de l'affichage »).
3. Dans l'application de bureau, pas de joueur automatique (le mode démo est celui du navigateur).
4. Sur une vraie chanson, la justesse des notes n'est chiffrée que là où une tablature humaine existe : intro de Nothing Else Matters ~60 % (F1). Le vote rend les répétitions cohérentes, pas forcément justes si toutes se trompent pareil. Une partition exacte demande une tablature humaine calée sur l'audio.
5. ~~Les niveaux appris par phrase ne sont pas sauvegardés~~ : fait à l'étape 4.
6. La conversion utilise le pipeline Python du dépôt (`uv run` dans `pipeline-ingest`) : l'app n'est pas encore un `.app` autonome qu'on pourrait copier sur un autre Mac.

---

## Étape 2 — Du MP3 au niveau jouable

### Ce que fait la chaîne

```
song.mp3 ─ffmpeg─▶ Demucs htdemucs_6s (GPU MPS) ─▶ guitare ──▶ Basic Pitch (CoreML) ─▶ nettoyage
                                                 └▶ reste ───▶ backing_track_no_guitar.wav (48 kHz)
                     batterie + basse ─▶ grille de temps (beats, mesures) ─┐
notes ─▶ quantification ─▶ Viterbi (doigtés) ─▶ niveaux de difficulté, phrases, accords ─▶ song_chart.json
```

Un morceau de 38 s est traité en **15 s** (séparation 3,6–4,8 s sur le GPU).

### Le côté « jeu » (format [schema/chart.schema.json](schema/chart.schema.json))

Le chart est pensé pour un jeu de rythme, pas seulement pour une tablature :
- **5 niveaux de difficulté par phrase** : chaque note/accord porte la plage de niveaux où il apparaît. Niveau 0 = temps forts et notes fondamentales, niveau 2 = noires et power chords, niveau 4 = la partie complète. Les gros accords se simplifient (fondamentale → power chord → accord complet). Chaque phrase a toujours au moins une note au niveau 0.
- **Phrases nommées par leur contenu** (A, B, A, B…), même si la transcription varie légèrement : base du Loop Trainer et de la difficulté dynamique.
- **Grille de temps** avec numéros de mesure (lignes de l'autoroute), **anchors** (position de la main → caméra et cases surlignées), **formes d'accords** nommées (E, Am, C/E, E5…) avec les doigts, **hand shapes**, **techniques** (hammer-on, pull-off, slide, bend, palm mute, harmoniques…).

**Cœur de jeu (Rust, `engine-rt/game`)** — lit le même JSON :
- jugement sur l'**horodatage de l'attaque** (±100 ms « bien », ±40 ms « parfait »), donc la confirmation tardive de E2 ne pénalise pas le joueur ; accords jugés par le vérificateur d'accords ;
- série, multiplicateur ×1→×4, points ;
- **difficulté dynamique par phrase** : ≥ 85 % de réussite → niveau +1, < 50 % → niveau −1, appliqué quand la phrase redevient visible (les notes ne changent jamais sous les yeux du joueur) ;
- compensation de latence (`input_offset`).

**Boucle complète vérifiée** : le chart généré depuis le MP3 est joué par un guitariste simulé, écouté par la détection de l'étape 1 (buffers de 64), jugé par le jeu :

| Niveau | Cibles (accords) | Réussite | Pire écart de timing |
|---|---|---|---|
| 0 | 26 (0) | 100 % | 0 ms |
| 1 | 32 (8) | 100 % | 0 ms |
| 2 | 48 (17) | 100 % | 8,7 ms |
| 3 | 71 (22) | 98,6 % | 45,8 ms |
| 4 | 73 (22) | 97,3 % | 8,4 ms |

Joué un demi-ton trop haut ou 250 ms en retard : **0 %**. Difficulté dynamique : A et B montent 0 → 1 → 2, chaque passage jugé au niveau affiché.

### Chiffres mesurés

**Solveur de doigtés Viterbi** (état = placement des notes + position de l'index ; coûts : vitesse de la main, étirement, cordes à vide, voicings, changement de cordes) :
- 29 tests : formes standard (E, Am, G, C, D, F barré, Bm barré, E5…), un riff connu en 12e position, gamme pentatonique en boîte à la 5e case, un riff en quartes sur Ré/Sol, aucune ligne de doubles-croches avec un saut de main > 5 cases, 3000 notes en < 0,5 s.
- **Face à de vrais guitaristes** (GuitarSet, 360 enregistrements avec la corde de chaque note) : **70,1 %** des notes sur la même corde que le guitariste (solos 66,9 %, accompagnements 71,3 %), contre 44,8 % pour « la case la plus basse ». Réglé sur les joueurs 00–02, validé sur les joueurs 03–05.

**Chaîne complète sur un morceau synthétique** (guitare double-piste saturée, basse, batterie, vérité terrain connue) :
- tempo **110,00 BPM** (vrai : 110), battements à **4,6 ms** médian, **100 %** des barres de mesure justes ;
- séparation : guitare r = **0,99** avec l'originale, fuite dans le backing 0,01 ;
- notes : **F1 0,86** (précision 0,89, rappel 0,83) ;
- tablature jouable : aucun saut rapide, écart max 4 cases.

**Imports** : Guitar Pro 3/4/5 (reprises et fins alternatives dépliées, changements de tempo, notes liées, techniques).

**Première vraie chanson : morceau A (rock, Drop C, 4 min 04)** — trois défauts trouvés et corrigés :

| | 1er passage | Après correction |
|---|---|---|
| Tempo | 103,3 BPM (faux : calé sur les accents 3+3+2 du riff, 2/3 du vrai tempo) | **81,0 BPM** stable |
| Accordage | E standard imposé → 6,6 % des notes injouables (fondamentales C2 perdues, « C5/G ») | **Drop C** détecté (note la plus grave jouée : C2) |
| Phrases | A…Z, toutes différentes | **A B C D E E E F G H H H I J J J K K K K** |

- Tempo : choix par cohérence métrique (support à ½, 1, 2 et 4 temps) + a priori autour de 100 BPM, puis suivi de battements plus « serré » (tightness 400) : l'affinage sur les attaques faisait dériver la grille jusqu'à 87 BPM.
- Accordage : les hauteurs ne disent pas comment la guitare est accordée (un C5 sonne pareil en Drop C et en C standard), mais elles disent jusqu'où elle descend. On prend l'accordage le plus courant qui atteint la note la plus grave jouée (≥ 3 notes et ≥ 0,5 %, pour ignorer une fuite de la basse). Les hauteurs du chart restent celles du disque : le joueur est toujours juste.
- Phrases : les notes transcrites d'une guitare saturée varient trop d'une répétition à l'autre (recouvrement 0,16), le son non (similarité 0,98). Les phrases sont donc reconnues sur le chroma de la piste guitare, aligné sur les temps.
- Traitement : 34 s pour 4 min de musique (séparation 18 s sur le GPU).

### Limites connues de l'étape 2

1. **Justesse des notes non mesurée sur une vraie chanson** : sur le morceau A, 2274 notes transcrites, 467 gardées après nettoyage (20 %), mais sans tablature de référence impossible de dire combien sont justes. Prochaine mesure : importer une tablature Guitar Pro du même morceau et comparer. Sur le morceau synthétique, Demucs rangeait ma guitare dans « other » : la chaîne bascule alors automatiquement sur guitar+other (`--stem` pour forcer).
2. **Les mesures (temps 1)** viennent d'une heuristique (grosse caisse, changements d'harmonie, notes de guitare). Le meilleur détecteur actuel (beat_this) était indisponible : son serveur de modèles renvoyait une erreur 500.
3. Basic Pitch rate environ 1 note sur 6 sur le morceau synthétique ; les techniques (bends, slides, HO/PO) ne sont pas encore extraites de l'audio, seulement des fichiers GP/XML.
4. Guitar Pro 6/7/8 (`.gpx`, `.gp`) ne sont pas encore lus.
5. Les sections s'appellent « Section N » (pas encore de détection couplet/refrain).
6. Le jeu ne juge pas encore la tenue des sustains ni la hauteur atteinte par les bends.

---

## Étape 1 — Cœur audio temps réel (53 tests)

### Architecture du dépôt

```
Cargo.toml                 workspace Rust (Engine-RT, puis src-tauri à l'étape 3)
engine-rt/
  dsp/     opensmith-dsp   DSP pur, sans I/O, sans allocation sur le chemin temps réel
    src/pitch/{mpm,yin}.rs   McLeod Pitch Method (principal) + YIN (contrôle), FFT
    src/tracker.rs           suivi de notes en streaming : attaques, fenêtre croissante,
                             détecteur de rupture de périodicité (re-pick, HO/PO, slides)
    src/onset.rs             détection d'attaque (pleine bande + aigus pour le re-pick)
    src/chord.rs             vérification d'accords : pics FFT, explication harmonique, chroma
    src/fx/                  noise gate, overdrive ADAA, convolution cabinet (IR .wav), limiteur
    src/fretboard.rs         accordages, (corde, case) ↔ MIDI, couleurs des cordes
    src/synth.rs             signaux de test déterministes (sinus, cordes pincées, Karplus-Strong)
  audio/   opensmith-audio  CoreAudio (cpal 0.18) : périphériques, flux duplex, rééchantillonnage adaptatif
  diag/    opensmith-diag   CLI : devices · run · selftest · gen · render
  game/    opensmith-game   règles du jeu : chart, jugement, score, difficulté dynamique
schema/chart.schema.json   format des charts, partagé Python ↔ Rust ↔ (bientôt) JS
pipeline-ingest/           Python 3.11 / uv : MP3 → stems → transcription → Viterbi → chart, imports GP/XML
app/                       Étape 3 (Tauri v2 + Three.js)
```

### Chiffres mesurés

**Détection de note** — MPM, cordes pincées synthétiques après silence, buffers de 64 échantillons comme CoreAudio, pire cas sur 4 alignements dans le buffer :

| Corde à vide | Attaque horodatée | Hauteur confirmée | Minimum physique |
|---|---|---|---|
| E2 82,41 Hz | 0,02 ms | 17,8 ms | 16,2 ms |
| A2 110 Hz | 0,02 ms | 13,3 ms | 12,1 ms |
| D3 146,83 Hz | 0,02 ms | 10,7 ms | 9,3 ms |
| G3 196 Hz | 0,02 ms | 8,5 ms | 7,5 ms |
| B3 246,94 Hz | 0,02 ms | 7,1 ms | 6,4 ms |
| E4 329,63 Hz | 0,02 ms | 6,2 ms | 5,3 ms |

- **Précision : 1200/1200 notes justes, 0 fausse note** sur tout le manche (6 cordes × 25 cases × 2 timbres × 4 alignements). MPM et YIN : 300/300 chacun en fenêtre statique, ±30 cents de désaccord, bruit à 20 dB de SNR, −50 à −6 dBFS.
- **< 10 ms garanti (assert) pour toute note ≥ E3 (165 Hz)**, soit 129 cases sur 150.
- **Corde/case** : E2 → corde de Mi grave à vide, résolution des 6 positions possibles d'une note selon la position de la main (`Tuning::resolve`).
- **Coût CPU** : 16,5 µs par buffer de 64 (1,2 % du budget de 1333 µs), p99,9 = 49 µs.

**Pourquoi E2 et A2 dépassent 10 ms.** Une période de E2 dure 12,1 ms. Aucun détecteur de périodicité ne peut confirmer une hauteur avant d'avoir vu la période se répéter : il faut ~1,25 période, soit 15–16 ms. Une méthode qui « devinerait » plus tôt (ajustement sinusoïdal) passerait les tests sur sinus purs mais se tromperait d'octave sur une vraie guitare. Ce qui compte pour le jeu, c'est l'**horodatage de l'attaque (< 0,1 ms pour toutes les cordes)** : la note est datée à l'attaque, la confirmation de hauteur peut arriver 1 frame d'écran plus tard (16 ms à 60 FPS) sans fausser le score.

**Accords** (grattés, 12 ms entre cordes, fenêtre 85 ms) :
- 12/12 voicings acceptés (E5, A5, E, Em, A, Am, D, Dm, G, C, F barré, B7), **128/128 accords faux rejetés**.
- Majeur vs mineur, corde manquante, note dissonante ajoutée : tous distingués.
- Acceptation 23–67 ms après la dernière corde.

**Chaîne DSP** :
- Noise gate : bruit à −70 dBFS atténué de plus de 60 dB, signal joué intact (< 0,1 dB), hystérésis sans claquement.
- Overdrive tanh asymétrique avec anti-aliasing ADAA : aliasing −27,9 dB contre −17,5 dB sans (≈ −10 dB).
- Cabinet : convolution partitionnée **sans latence**, identique à la convolution directe (erreur < 1e-5) ; chargement d'IR `.wav` (toute profondeur, rééchantillonnage, normalisation) ; IR 4×12 intégrée.
- Limiteur de sécurité : la sortie ne dépasse jamais 0,99.

**Flux duplex CoreAudio** — mesuré sur ce Mac (micro intégré en repli, câble absent) :
- 48 kHz, buffers de **64 frames acceptés** sur l'entrée et la sortie, 750 callbacks/s.
- **Latence aller-retour 9,21 ms** = entrée 2,88 + anneau 2,00 + sortie 4,33. DSP : 8 µs par callback (0,6 %).
- 8 s de flux : 0 underrun, 0 overrun, dérive d'horloge mesurée +0 ppm.
- Simulation (sans matériel) : horloges décalées de ±100 et ±300 ppm compensées à ±0,5 ppm, **0 coupure** ; callbacks simultanés en ordre aléatoire : 0 coupure ; le son traverse le pont à −71,5 dB d'erreur près.
- Les deux callbacks n'allouent jamais (prouvé par un allocateur compteur).

### Batterie de tests (53)

| Fichier | Prouve |
|---|---|
| `dsp/src/*` (12 tests unitaires) | notes ↔ MIDI, manche, FFT = corrélation naïve, biquads, rééchantillonneur |
| `dsp/tests/pitch_accuracy.rs` | MPM et YIN : 100 % sur 150 positions × 2 timbres, bruit, désaccord, niveaux |
| `dsp/tests/latency.rs` | tableau de latence par corde, 1200 notes en streaming, < 10 ms dès E3, bruit et ronflette 50 Hz ignorés |
| `dsp/tests/riff.rs` | gamme chromatique en doubles-croches à 120 BPM, notes répétées, aller-retour de médiator à 160 BPM, YIN, hammer-on/pull-off, slide, bend |
| `dsp/tests/chords.rs` | accords justes acceptés, faux rejetés, majeur/mineur, latence de vérification, chromagramme |
| `dsp/tests/fx.rs` | gate, overdrive (bornée, sans DC, THD croissante), ADAA, convolution, IR `.wav`, limiteur |
| `dsp/tests/rt_safety.rs` | 0 allocation sur le chemin audio, budget CPU |
| `audio/src/devices.rs` | reconnaissance du câble guitare USB par son nom |
| `audio/tests/bridge.rs` | pont duplex simulé : notes et audio traversent, dérive ±300 ppm, ordre aléatoire |
| `audio/tests/rt_bridge.rs` | 0 allocation dans les deux callbacks CoreAudio |

### Limites connues et écarts à la spec

1. **Confirmation de hauteur > 10 ms sur E2 (17,8 ms), A2 (13,3 ms), D3 (10,7 ms)** : limite physique expliquée plus haut. L'attaque, elle, est datée en < 0,1 ms.
2. **Aller-retour 9,2 ms au lieu de < 5 ms** : CoreAudio annonce à lui seul 7,2 ms de latence matérielle pour le micro et les haut-parleurs intégrés (2,88 + 4,33). Pistes : sortie sur une interface audio dédiée, agrégat CoreAudio (un seul callback, sans anneau : −2 ms).
3. **Pas encore testé avec le vrai câble guitare USB ni une vraie guitare** (câble absent pendant le développement). La détection du câble est vérifiée sur son nom macOS.
4. **Pas de Neural Amp Modeler (`.nam`)** pour l'instant : l'étape 1 demandait gate + overdrive/cabinet. NAM viendra comme étage d'ampli interchangeable.
5. Un re-pick très doux sur la même note, sans montée d'énergie, peut être étiqueté « legato » (la note et son horodatage restent justes).
6. Le test acoustique (haut-parleurs → micro) n'a rien capté : la sortie du Mac était en sourdine. Les tests simulés couvrent ce chemin.
7. Au démarrage du flux, CoreAudio émet parfois une notification « overload » pendant qu'il passe le périphérique à 64 frames ; aucune coupure n'est comptée.

### Décisions techniques

- **MPM en principal** (moins de signal nécessaire que YIN : 1,25 période contre 2), YIN gardé comme contrôle croisé et sélectionnable (`--algo yin`).
- **Analyse sur une copie filtrée à 2 kHz** : la hauteur est dans les premiers harmoniques ; les partiels aigus de l'attaque masquaient la périodicité.
- **Fenêtre qui grandit depuis l'attaque**, sans fenêtre fixe : la hauteur est annoncée dès que la preuve suffit.
- **Détecteur de rupture de périodicité** (prédiction à une période, sur les 5 premiers harmoniques) : capte les re-picks que l'énergie ne voit pas et ouvre une fenêtre propre à chaque changement de note.
- **Vérification d'accords** plutôt que transcription polyphonique aveugle : le jeu connaît l'accord attendu.
- **Duplex = deux flux + anneau sans verrou + rééchantillonnage adaptatif** (boucle à verrouillage de délai, comme les ponts JACK) : le câble USB et la sortie ont deux quartz différents.

### Commandes

```bash
cargo test --workspace
```

```bash
cargo run --release -p opensmith-diag -- devices
```

```bash
cargo run --release -p opensmith-diag -- selftest
```

```bash
cargo run --release -p opensmith-diag -- run
```

## Commandes de l'étape 2

```bash
cd pipeline-ingest && uv sync
```

```bash
uv run opensmith-ingest audio chanson.mp3 -o out/chanson
```

```bash
uv run opensmith-ingest tab out/chanson/song_chart.json --level 2
```

```bash
uv run opensmith-ingest guitarpro morceau.gp5
```

```bash
uv run pytest -m slow
```

## Commandes de l'étape 3

```bash
cd app && npm install
```

```bash
npm run tauri dev
```

```bash
npm run dev
```

```bash
npm test
```

## Prochaines étapes

Un premier essai avec le câble guitare USB et une vraie guitare (Loop Trainer compris)  ; la basse (autoroute à quatre cordes) ; choisir l'accordage à la main quand il n'y a pas de tablature (la détection se trompe sur les morceaux très saturés : le morceau C pris pour du Drop D, le morceau D pour du Mi standard) ; une `.app` autonome.

/** English for the lessons (see ../../i18n.ts). */
export const LESSONS: Record<string, string> = {
  // Menu and screen
  'Leçons': 'Lessons',
  'Lent': 'Slow',
  'Attente': 'Wait',
  'Le jeu s’arrête sur chaque note ou accord et attend que tu le joues.': 'The game stops on each note or chord and waits for you to play it.',
  'Le jeu t’attend': 'The game is waiting',
  'Place tes doigts, puis joue : ça repart. Espace pour passer une note.': 'Place your fingers, then play: it goes on. Space to skip a note.',
  'Pour apprendre à jouer, en partant de zéro': 'Learn to play, starting from scratch',
  '{done} sur {total} réussies · prochaine : {title}': '{done} of {total} passed · next: {title}',
  'Toutes réussies : place aux morceaux !': 'All passed: on to real songs!',
  '{done} sur {total} réussies': '{done} of {total} passed',
  'Pour commencer de zéro. Chaque leçon dure moins d’une minute, sur un métronome : atteins l’objectif pour passer à la suivante.':
    'To start from scratch. Each lesson lasts under a minute, over a metronome: reach the goal to move on to the next one.',
  'Objectif {goal}': 'Goal {goal}',
  'Objectif {goal} · ton meilleur {best}': 'Goal {goal} · your best {best}',
  'Comment faire': 'How to play it',
  'Rejouer la leçon': 'Play the lesson again',
  'Commencer la leçon': 'Start the lesson',
  'Tempo : {bpm} battements par minute': 'Tempo: {bpm} beats per minute',

  // Playing and results
  'Leçon {n} · {title}': 'Lesson {n} · {title}',
  'Leçons OpenSmith': 'OpenSmith lessons',
  'Impossible d’ouvrir la leçon : {error}': 'Could not open the lesson: {error}',
  'Leçon suivante': 'Next lesson',
  'Leçon réussie !': 'Lesson passed!',
  'Entraînement au ralenti': 'Slow practice',
  'Encore un essai !': 'One more try!',
  'Prochaine leçon : {title}': 'Next lesson: {title}',
  'Toutes les leçons sont réussies : place aux vrais morceaux !': 'Every lesson passed: on to real songs!',
  'Reviens à 100 % de la vitesse pour réussir la leçon.': 'Go back to 100% speed to pass the lesson.',
  'Tu as joué {acc} des notes, l’objectif est {goal}.': 'You played {acc} of the notes; the goal is {goal}.',

  // 1. The six strings
  'Les six cordes': 'The six strings',
  'Chaque corde a sa couleur : la reconnaître et la jouer à vide, sans la main gauche.':
    'Each string has its colour: recognise it and play it open, without the left hand.',
  'Rouge = Mi grave, la plus grosse corde, la plus proche de ton visage. Puis jaune, bleu, orange, vert, et violet = Mi aigu, la plus fine.':
    'Red = low E, the thickest string, the one closest to your face. Then yellow, blue, orange, green, and purple = high E, the thinnest.',
  'Une corde à vide s’affiche comme une barre : on la joue sans appuyer nulle part.':
    'An open string shows as a bar: you play it without pressing anywhere.',
  'Gratte une seule corde avec le médiator, vers le bas, quand la note touche la ligne.':
    'Pick a single string, downwards, when the note reaches the line.',

  // 2. In time
  'En rythme': 'In time',
  'Jouer pile sur le clic du métronome, une corde à vide par temps.': 'Play right on the metronome’s click, one open string per beat.',
  'Compte « 1, 2, 3, 4 » avec les clics avant la première note.': 'Count “1, 2, 3, 4” with the clicks before the first note.',
  'Une note par clic : la note touche la ligne au moment du clic.': 'One note per click: the note reaches the line on the click.',
  'Laisse le médiator tout près des cordes entre deux notes.': 'Keep the pick close to the strings between notes.',

  // 3. First frets
  'Les premières cases': 'The first frets',
  'Appuyer sur une case avec la main gauche pour changer la note.': 'Press a fret with the left hand to change the note.',
  'Appuie juste derrière la frette (la barre de métal), du bout du doigt, sans écraser.':
    'Press just behind the fret (the metal bar), with your fingertip, without squeezing.',
  'Un doigt par case : l’index sur la case 1, le majeur sur la 2, l’annulaire sur la 3, le petit doigt sur la 4.':
    'One finger per fret: index on fret 1, middle on 2, ring on 3, little finger on 4.',
  'Le numéro sur la note est la case ; la lumière sur le manche montre où poser le doigt.':
    'The number on the note is the fret; the light on the neck shows where to put your finger.',

  // 4. 1-2-3-4
  'Le 1-2-3-4': 'The 1-2-3-4',
  'Les quatre doigts l’un après l’autre, sur toutes les cordes : l’échauffement de tous les guitaristes.':
    'The four fingers one after the other, on every string: every guitarist’s warm-up.',
  'Cases 1, 2, 3, 4 sur chaque corde, du Mi grave au Mi aigu.': 'Frets 1, 2, 3, 4 on each string, from low E to high E.',
  'Laisse chaque doigt posé jusqu’à la note suivante.': 'Leave each finger down until the next note.',
  'Lentement et proprement plutôt que vite.': 'Slow and clean rather than fast.',

  // 5. First melody
  'Ta première mélodie': 'Your first melody',
  '« Au clair de la lune » sur deux cordes : la corde de Sol (orange) et celle de Si (verte).':
    '“Au clair de la lune” on two strings: the G string (orange) and the B string (green).',
  'Sol : la corde orange à vide. La : la même corde, case 2, avec le majeur. Si : la corde verte à vide.':
    'G: the orange string open. A: the same string, fret 2, with the middle finger. B: the green string open.',
  'Les notes longues ont une traînée : laisse-les sonner jusqu’au bout.': 'Long notes have a trail: let them ring to the end.',
  'La mélodie passe deux fois.': 'The melody comes twice.',

  // 6. E5
  'Ton premier accord : E5': 'Your first chord: E5',
  'Trois cordes graves d’un coup : l’accord du rock, avec deux doigts.': 'Three low strings at once: the rock chord, with two fingers.',
  'Index sur la case 2 de la corde jaune (La), majeur sur la case 2 de la corde bleue (Ré). La corde rouge reste à vide.':
    'Index on fret 2 of the yellow string (A), middle finger on fret 2 of the blue string (D). The red string stays open.',
  'Gratte seulement les trois cordes du haut, d’un seul geste vers le bas.': 'Strum only the top three strings, in one downward stroke.',
  'Un accord s’affiche dans un cadre, avec son nom.': 'A chord shows in a frame, with its name.',

  // 7. Em
  'Mi mineur (Em)': 'E minor (Em)',
  'Le premier accord sur les six cordes, avec seulement deux doigts.': 'The first chord on all six strings, with only two fingers.',
  'Majeur sur la case 2 de la corde jaune (La), annulaire sur la case 2 de la corde bleue (Ré).':
    'Middle finger on fret 2 of the yellow string (A), ring finger on fret 2 of the blue string (D).',
  'Gratte les six cordes vers le bas, de la rouge à la violette.': 'Strum all six strings downwards, from red to purple.',
  'Les numéros sur le manche disent quel doigt poser.': 'The numbers on the neck tell you which finger to use.',

  // 8. Am
  'La mineur (Am)': 'A minor (Am)',
  'Un accord à trois doigts, sans la corde de Mi grave.': 'A three-finger chord, without the low E string.',
  'Index case 1 de la corde verte (Si), majeur case 2 de la corde bleue (Ré), annulaire case 2 de la corde orange (Sol).':
    'Index on fret 1 of the green string (B), middle finger on fret 2 of the blue string (D), ring finger on fret 2 of the orange string (G).',
  'Commence à gratter à la corde jaune (La) : la rouge ne sonne pas.': 'Start strumming from the yellow string (A): the red one stays silent.',
  'Courbe les doigts pour ne pas toucher les cordes voisines.': 'Curl your fingers so they don’t touch the strings next to them.',

  // 9. Changing chords
  'Changer d’accord': 'Changing chords',
  'Passer de Mi mineur à La mineur sans perdre le rythme.': 'Go from E minor to A minor without losing the beat.',
  'Majeur et annulaire gardent leur forme : ils descendent ensemble d’une corde, puis l’index se pose case 1 de la corde verte.':
    'Middle and ring fingers keep their shape: they move down one string together, then the index goes on fret 1 of the green string.',
  'Prépare le changement pendant le dernier temps de l’accord.': 'Get ready for the change during the chord’s last beat.',
  'Trop rapide ? Ralentis avec la flèche ↓ pour t’entraîner, puis reviens à 100 % pour réussir la leçon.':
    'Too fast? Slow down with the ↓ arrow to practise, then go back to 100% to pass the lesson.',

  // 10. First riff
  'Ton premier riff': 'Your first riff',
  'Trois power chords qui s’enchaînent : E5, G5 et A5, comme dans un vrai morceau de rock.':
    'Three power chords in a row: E5, G5 and A5, like in a real rock song.',
  'G5 : index case 3 sur la rouge, annulaire et petit doigt case 5 sur la jaune et la bleue. Même forme que E5, avec un doigt de plus.':
    'G5: index on fret 3 of the red string, ring and little fingers on fret 5 of the yellow and blue strings. Same shape as E5, with one more finger.',
  'A5 : corde jaune à vide, index et majeur case 2 sur la bleue et l’orange.': 'A5: yellow string open, index and middle fingers on fret 2 of the blue and orange strings.',
  'Le riff passe quatre fois : regarde où va la main avant le changement.': 'The riff comes four times: look where the hand goes before each change.',

  // Recording sessions
  'Ta guitare, pour mieux t’écouter': 'Your guitar, so the game hears it better',
  'Deux séances de quelques minutes, sans objectif : ta guitare est enregistrée sur ce Mac pendant que tu joues, pour régler la détection des notes sur son son.':
    'Two sessions of a few minutes, with no goal: your guitar is recorded on this Mac as you play, to tune the note detection to its sound.',
  '{n} enregistrements · {minutes} min': '{n} recordings · {minutes} min',
  'Commencer l’enregistrement': 'Start recording',
  'Enregistrement terminé': 'Recording done',
  'Merci ! Ta guitare est enregistrée sur ce Mac (dossier Musique → OpenSmith → .takes).': 'Thanks! Your guitar is recorded on this Mac (Music → OpenSmith → .takes folder).',
  'En mode démo, rien n’est enregistré : il faut l’app et ta guitare.': 'Nothing is recorded in demo mode: it takes the app and your guitar.',
  'Ta guitare, note par note': 'Your guitar, note by note',
  'Chaque corde à vide, puis case après case jusqu’à la 12 : le jeu apprend comment sonne ta guitare.':
    'Each open string, then fret after fret up to the 12th: the game learns how your guitar sounds.',
  'Une note tous les deux clics : laisse-la sonner jusqu’à la suivante. Trop rapide ? Choisis « Lent ».': 'One note every two clicks: let it ring until the next one. Too fast? Choose “Slow”.',
  'Une corde après l’autre, de la rouge à la violette. Un seul doigt suffit : suis la lumière sur le manche.':
    'One string after the other, from red to purple. One finger is enough: follow the light on the neck.',
  'Une note ratée n’est pas grave : elle est simplement laissée de côté.': 'A missed note does not matter: it is simply left out.',
  'Ta guitare, en accords': 'Your guitar, in chords',
  'Neuf accords, quatre fois chacun : le jeu apprend comment sonnent tes accords.': 'Nine chords, four times each: the game learns how your chords sound.',
  'Chaque accord est gratté quatre fois vers le bas, puis tu as deux temps pour changer.': 'Each chord is strummed down four times, then you have two beats to change.',
  'Les numéros sur le manche disent où poser chaque doigt ; un accord pas tout à fait propre sert aussi.':
    'The numbers on the neck say where each finger goes; a chord that is not quite clean helps too.',
  'Mi, Mi mineur, La, La mineur, Do, Ré, Sol, puis E5 et A5.': 'E, E minor, A, A minor, C, D, G, then E5 and A5.',
};

# 🔔 Jingle d'ouverture

`start.mp3` (6 s) est la **signature sonore de la station**. Il passe à l'antenne
au démarrage d'une émission : premier passage après un appui sur lecture, ou
premier passage après un changement de sujet — et **pas** entre deux passages
d'une même émission, sinon il deviendrait un tic toutes les minutes.

C'est [public/js/app.js](../../public/js/app.js) qui le joue (voir `armJingle`,
`playJingle`, `cycleIntro`). Il ne part jamais dans l'audio archivé (`shows/`) ni
dans le flux podcast : comme le fond musical, il n'existe qu'à la lecture.

## Le motif

Une seule note — **la 5 (880 Hz)** — frappée trois fois en noires à 120 BPM, puis
reprise comme sommet de l'accord final. Ce qui rend la signature reconnaissable,
c'est le rythme (trois frappes courtes, une pause, l'accord), pas la mélodie.
L'accord qui arrive dessus est volontairement **sans tierce** (la + quinte +
octaves) : il tombe juste aussi bien sur les ambiances en la mineur que sur celles
en do majeur du fond musical.

Trois variantes (rythme, timbre, tonalité) ont été composées pour choisir à
l'oreille ; la cloche en la a été retenue, et elles ont été retirées du projet.

## Regénérer

Tout est synthétisé par le projet — cloche à partiels inharmoniques, pavé de
sinus, souffle qui monte vers l'accord — donc aucune question de licence :

```bash
bun scripts/make-jingle.ts        # → public/jingle/start.mp3, 6 s
bun scripts/make-jingle.ts 8      # → 8 s
```

La durée est bornée entre 4 et 20 s, et vaut 6 s par défaut.

Le niveau crête est le même que celui des fonds musicaux (voir
`scripts/audio.ts`, constante `PEAK`), pour qu'on puisse passer du jingle au fond
sans retoucher le volume du lecteur. Le fichier n'est **pas** reproductible au
bit près : le souffle est du bruit aléatoire, donc deux exécutions donnent deux
MP3 différents à l'oreille identique.

## Réglage

Le jingle suit le réglage **« Fond musical d'attente »** de l'onglet Sources :
choisir « Aucune musique » coupe le jingle *et* le fond. Sinon il joue un peu plus
fort que le fond (0,5 contre 0,34 sous le volume général), et comme eux il
respecte la sourdine.

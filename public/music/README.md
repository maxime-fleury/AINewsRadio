# 🎵 Fonds musicaux d'attente

Ces pistes comblent le silence **quand le tampon de segments est vide** : pendant
que le prochain passage se prépare, la radio joue un fond musical, l'annonce
parlée passe par-dessus, et tout s'arrête dès qu'un segment démarre.

## Comment ça marche

- `GET /api/music` renvoie les pistes à jouer selon les réglages.
- Le lecteur tire les pistes au hasard à bas volume, sans répétition immédiate
  si plusieurs sont disponibles. À la fin d’une piste, il en choisit une autre.
- La musique s’arrête immédiatement au démarrage des voix, à la pause ou au stop.
- **Aucune piste = pas de musique** : l'annonce Edge seule reste, comme avant.

## Le jingle d'ouverture

Ce dossier ne contient que le **fond d'attente**. La signature sonore jouée au
démarrage d'une émission vit à part, dans `public/jingle/start.mp3` : elle n'est
pas une piste de fond et ne doit donc pas se retrouver dans cette liste (voir
[public/jingle/README.md](../jingle/README.md)).

## Choisir un dossier depuis le navigateur

Dans **Direct → Musique pendant la préparation → Choisir un dossier audio**,
choisis tes fichiers personnels. Les sous-dossiers sont inclus, aucun fichier
n’est envoyé au serveur. Le nom du dossier, le nombre de pistes et le fichier
joué sont affichés. Le choix doit être refait après fermeture ou rechargement.

Pour un choix permanent sur la machine du serveur, utilise les réglages suivants.

## Les deux réglages (Réglages → Sources)

| Réglage | Effet |
| --- | --- |
| `musicMood` — type de musique | `aucun`, `ambient`, `calme`, `electro`, `tension`. Sans dossier choisi, c'est l'ambiance livrée correspondante qui passe. `aucun` coupe aussi le jingle d'ouverture. |
| `musicFolder` — dossier de musique | Chemin absolu vers un dossier de pistes à toi. S'il est rempli, **il gagne sur le type** : les fichiers audio reconnus sont joués au hasard. |

Le dossier est lu à plat (pas de sous-dossiers), seules les extensions
`mp3, ogg, m4a, wav, flac, aac` sont reconnues, et chaque fichier est servi par
`GET /api/music/file?name=…` — nom de fichier seul, sans chemin, avec support des
plages (seek) et refus de tout ce qui sort du dossier. Si le dossier est
introuvable ou vide, le réglage le dit et aucune musique ne joue.

```
public/music/bed-ambient.mp3   ← livré, synthétisé par le projet
public/music/bed-calme.mp3
public/music/bed-electro.mp3
public/music/bed-tension.mp3
```

## Ajouter tes propres pistes

Dépose simplement des fichiers ici — ils seront pris en compte au prochain
rechargement, sans configuration :

```
public/music/mon-jingle.mp3
public/music/bed-nuit.mp3
```

Si une ambiance choisie n'est pas installée, l'app joue ce qu'elle trouve plutôt
que rien.

Privilégie des pistes **libres de droits** (CC0, CC-BY, ou domaine public) :
Free Music Archive, Pixabay Music, Incompetech, ccMixter… Les pistes CC-BY
demandent une attribution — garde le crédit à côté du fichier si tu les utilises.

Encore une fois : ce qui compte n'est pas seulement la source, mais la
**destination**. Ici, la musique est jouée par le navigateur, en parallèle du
direct ; elle n'est **pas mixée dans les MP3 archivés** (`shows/`) ni dans le
flux podcast `/feed.xml`. Tant que c'est le cas, la musique ne sort pas de la
machine — mais si un jour tu la mixes aux archives ou au feed, ce n'est plus une
écoute privée : assure-toi alors que les pistes le permettent. C'est le même
raisonnement pour tes propres fichiers : un dossier personnel reste personnel.

## Régénérer les ambiances fournies

Les quatre pistes livrées sont **synthétisées par le projet**, donc sans aucune
question de licence. Elles partagent le même niveau crête, pour qu'on puisse
passer de l'une à l'autre sans retoucher le volume :

```bash
bun scripts/make-music-bed.ts                  # → bed-ambient.mp3, 48 s
bun scripts/make-music-bed.ts all              # les quatre ambiances
bun scripts/make-music-bed.ts electro 90       # → bed-electro.mp3, 90 s
```

Le script synthétise chaque ambiance à partir de sinus additionnés (progression
d'accords, attaque, détune, pompage rythmique, filtre passe-bas qui respire,
fondu de boucle), puis encode en MP3 via ffmpeg. `ambient` est une nappe
Am–F–C–G, `calme` un majeur lent et sombre, `electro` une pulsation à 120 BPM
avec frappe grave, `tension` des intervalles dissonants avec trémolo.

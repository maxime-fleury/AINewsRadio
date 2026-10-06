# 🔮 AI News Radio

Une radio d'actualité qui se génère toute seule : elle cherche les news sur
internet (RSS + Google News), écrit un dialogue entre **un ou deux
présentateurs**, le fait lire par des voix de synthèse, puis diffuse le tout en
continu — pendant que le transcript défile mot à mot à l'écran.

```
flux RSS ──▶ collecte + pertinence ──▶ script (LLM) ──▶ voix (TTS) ──▶ 🎧
             Google News RSS           2 personnalités    Edge ou OpenRouter
```

## Démarrage

```bash
bun install
bun run dev              # http://localhost:3000 (port suivant si occupé)
PORT=3002 bun run dev    # forcer un port précis
bun run typecheck        # tsc --noEmit
bun test                 # tests unitaires (regroupement, dialogue, transcript)
```

Réglages, catalogue de modèles, compteurs et archives vivent **dans le dossier du
projet** (`.data/`, `shows/`), même si la commande est lancée depuis ailleurs.

Ça marche **sans clé OpenRouter** : la radio lit alors les titres bruts, en
alternant les deux voix. Pour la rédaction et les réponses aux questions :

1. ouvrez **Réglages → Modèles**, collez une clé OpenRouter, *Tester*, *Enregistrer* ;
2. ou lancez avec `OPENROUTER_API_KEY=sk-or-… bun run dev` (la clé est aussi
   stockée dans `.data/settings.json`).

## Direct continu, contexte et coûts

- **Tampon initial : 3 clips** (réglage « Segments d'avance »). Les clips prêts s'enchaînent sans pause imposée. Le script est préparé avec les angles déjà en file, séparément du contexte entendu.
- Une **question/débat** ne jette plus les clips prêts : ils continuent pendant la préparation. La réponse prête prend la tête de la file après le clip courant. Option « Interrompre immédiatement » disponible.
- **Pause** suspend réellement lecture et génération ; la file et la demande prioritaire restent disponibles. **Stop** vide l'antenne ; aucune réponse tardive ne peut la relancer. Erreurs : essais bornés, puis pause après trois échecs.
- **Annonce Edge** : quand le tampon est vide pendant la synthèse, une annonce du titre prévu et un compte à rebours indicatif de 10 s accompagnent l'attente. Pas de délai obligatoire si un clip est prêt ; pas de promesse que toute génération finit en 10 s.
- **Actualité / Exploration / Hybride** : exploration n'interroge pas les flux ; hybride cherche puis approfondit. Les recherches réussies sont mises en cache par sujet/langue/flux, avec une fréquence indépendante de la durée du segment (10 min par défaut).
- **Conversation** : six passages entendus maximum, bornés à 1 600 caractères chacun, servent à comprendre « pourquoi ? » ou « et en France ? ». La file non entendue sert uniquement à éviter les répétitions. La mémoire anti-redite des sources est confirmée à la fin d'une écoute complète, pas lors de la génération.
- **Personnalisation** : humour, désaccord, technicité, longueur des répliques et fréquence d'interpellation. Les personnalités ne changent pas les faits.
- **Coûts / minute / heure** : coût LLM + TTS divisé par durée audio produite ; projection affichée après une minute produite dans cette page. Échantillon réinitialisé après un changement de moteur/modèle. Ce n'est pas une facture exacte : appels abandonnés, électricité locale et annonce Edge ne sont pas inclus.

## TTS local : Chatterbox Multilingual V3

Installation isolée dans `.venv-chatterbox`, poids locaux dans `.local-tts`. Démarrer `bun run tts:local` puis sélectionner le moteur local dans Équipe & voix. Références WAV importables pour les deux présentateurs. Voir [le guide local](local-tts/README.md) et [les mesures](reports/chatterbox-benchmark.json).

Configuration retenue : **Hy3** économique pour la rédaction ; **Chatterbox local** sélectionné, **Fish gratuit** reste disponible ; **Edge gratuit** en repli. Grok est disponible mais n'est pas activé comme secours payant. Les modèles Gemini TTS uniquement PCM ne sont pas compatibles avec la concaténation MP3 actuelle et ne doivent pas être sélectionnés pour le direct.

## Fonctionnement

| Étape | Détail |
| --- | --- |
| **1. News** | Google News RSS (recherche par thème) + flux suivis (Le Monde, France 24, France Info, Numerama, BBC…). Déduplication, **regroupement des dépêches qui racontent la même histoire** (un seul passage à l'antenne, les sujets couverts par plusieurs médias remontent), classement par pertinence puis par langue de l'émission. |
| **1 bis. Mémoire** | Les histoires **déjà passées à l'antenne aujourd'hui** sont écartées du bulletin suivant (`.data/played.json`) : on ne redit pas deux fois la même chose à 10h et à 10h01. S'il ne reste rien de neuf, le modèle enchaîne un court « point de situation » en le signalant. |
| **2. Script** | **Un seul appel** écrit tout le dialogue JSON : `title`, `turns[]` (`speaker` + `text`), `usedSources[]`. Le prompt impose la répartie (alternance stricte des voix, chaque réplique rebondit sur la précédente, prénoms, questions croisées) ; un filet de sécurité redistribue les répliques si le modèle a tout mis sur une seule voix. Les deux personnalités et le profil de l'auditeur entrent dans le prompt, avec tutoiement imposé. Repli automatique sur les titres si la clé manque ou si le modèle échoue. |
| **3. Voix** | Une synthèse **par réplique** (avec la voix de son présentateur), puis concaténation MP3 octet à octet et recalcul des timings sur la timeline globale. |
| **4. Diffusion** | Le client enchaîne les segments. À la pause, **plus aucune news n'est demandée** ; la file déjà prête attend la reprise. |

### Cadence, file et pause

- *Cadence* (30 s → 5 min) : durée cible d'un bulletin, le script est calibré pour
  être lu en environ ce temps.
- *Segments d'avance* : tampon initial et nombre de bulletins préparés pendant la diffusion (3 par défaut).
- **Play** démarre, **Pause** arrête tout (audio, requêtes en cours, minuteur),
  **Stop** vide la file, **⏭** saute au bulletin suivant prêt.

### Ce qui survit au redémarrage

Au lancement, la console retrouve les dernières émissions archivées : elles
réapparaissent dans **« News & recherches »** avec leur transcript, leurs sources
et un bouton *Réécouter*. Les compteurs cumulés (coût, bulletins, minutes
d'audio, temps de chaque étape) sont relus dans `.data/stats.json` et reprennent
là où ils en étaient ; *Vider la session* les remet à zéro sans toucher aux
archives, qui restent réécoutables dans le Replay.

### Transcript synchronisé

- **Edge TTS** renvoie les timings de chaque mot (`WordBoundary`) : la
  synchronisation est exacte, y compris sur un dialogue multi-voix.
- **OpenRouter** ne renvoie pas de timings : ils sont estimés à partir de la durée
  réelle de l'audio et de la longueur de chaque mot.
- Le mot prononcé est surligné, la phrase active s'éclaire, chaque réplique est
  colorée par présentateur. Un clic sur un mot positionne la lecture.

### À l'antenne : un résumé, jamais un défilé de sources

Le prompt de rédaction interdit trois choses, pour que ça s'écoute comme une
vraie matinale et pas comme un lecteur de flux :

- **pas de nom de média** (« selon Le Monde », « d'après Reuters »…) — l'auditeur
  lit les sources dans l'application, pas besoin de les entendre ;
- **pas d'heure ni de date de publication** — on raconte ce qui s'est passé ;
- **pas de répétition** — un sujet revient une seule fois, en fusionnant ce que
  disent les articles qui le couvrent (le regroupement se fait déjà à la source).

### La mémoire éditoriale

Une histoire entendue à 10h ne revient pas à 10h01. Les sujets réellement passés à
l'antenne sont mémorisés pour la journée et écartés du bulletin suivant : deux
dépêches qui racontent la même histoire sont reconnues par leurs mots significatifs
(le même regroupement que celui effectué à la source). Réglages → Sources permet de
couper la mémoire, de la consulter et de l'effacer d'un clic. Les questions, elles,
ne sont jamais écartées : l'auditeur les a posées, on y répond.

### Un débat contradictoire

Le bouton **Débat**, à côté de la zone de question, transforme la question saisie (ou
le sujet sélectionné) en débat à deux voix : chaque présentateur choisit et annonce
une position, la tient jusqu'au bout, concède un point quand l'autre en marque un — et
**l'auditeur sert de modérateur** : sa question ouvre le débat, la conclusion lui est
adressée. Alternance stricte, arguments factuels appuyés sur les sources (ou sur la
mémoire, annoncée une fois, quand il n'y a pas de dépêche), aucun vainqueur proclamé.
Il faut deux présentateurs et une clé OpenRouter. Les débats s'archivent avec le
suffixe `_debat` et se filtrent dans le Replay.

### Répondre de mémoire (sujets libres)

Un sujet qui n'est pas de l'actualité chaude (« comment marche un réacteur à eau
pressurisée ? ») n'a pas de dépêche à l'instant T. Avec l'option **« Sans dépêche,
répondre de mémoire »** (activée par défaut), le modèle traite alors la question à
partir de ses connaissances générales : il l'annonce une fois à l'antenne, reste
factuel, et n'invente ni chiffre, ni date, ni citation. Pour une question dont les
sources existent mais sont hors sujet, il complète de la même façon en le
disant. Désactivée, la radio se contente de dire qu'elle n'a rien trouvé.

### Les modèles : rédaction et tâches rapides

Réglages → Modèles distingue deux modèles :

- le **modèle de rédaction** écrit les bulletins, les réponses et les débats ;
- le **modèle des tâches rapides** (optionnel) transforme une question en requête de
  recherche et rédige les récapitulatifs. Un petit modèle suffit et coûte moins cher ;
  laissé vide, le modèle de rédaction s'en charge aussi.

Les modèles qui « réfléchissent » (qwen3, gpt-oss…) dépensent des tokens avant
d'écrire : l'application leur laisse de la marge et force la réponse en JSON, sinon
ils rendent une réponse vide.

### Colonne « News & recherches »

Pour chaque segment : la requête utilisée, le résultat de chaque flux
(✓ nombre d'articles / ✕ erreur), les sources retenues (cliquables), les timings
de chaque étape, le modèle utilisé, le coût et le chemin du fichier archivé.

## Personnalisation

### Les présentateurs (Réglages → Équipe & voix)

**1 ou 2 présentateurs.** Pour chacun : **prénom**, **personnalité** (rôle, ton,
tics de langage…) et **voix** (la liste des voix Edge de la langue, ou les voix du
modèle TTS OpenRouter). C'est cette personnalité qui pilote l'écriture : elle est
injectée telle quelle dans le prompt de rédaction, et chaque réplique est lue par
la voix de son présentateur. Deux présentateurs ne peuvent pas partager la même
voix (elle est décalée automatiquement si besoin).

**Gabarits de personnalité** (menu déroulant de chaque fiche) : Optimiste,
Pessimiste, Ironique, Bouffon, Taquine (façon Nagatoro), Analyste, Vulgarisateur,
Sceptique, Dramatique, Complice, Zen, Urgentiste. Chaque gabarit propose un prénom,
une personnalité et une voix assortie au genre, dans la langue de l'émission.

**Créer ses propres gabarits.** Sous les fiches : un libellé, un genre (pour la
voix suggérée), un prénom et une personnalité en français, et la version anglaise
en option. *Enregistrer le gabarit* l'ajoute aussitôt à la liste — il devient
choisissable dans les fiches présentateurs et peut être appliqué d'un clic sur
« voix 1 » ou « voix 2 ». Chaque gabarit perso est modifiable et supprimable.

**Import / export de l'équipe.** *Exporter l'équipe* télécharge un JSON avec les
deux fiches présentateurs, l'auditeur et vos gabarits persos ; *Importer un JSON*
le relit (un gabarit du fichier remplace celui qui porte le même identifiant, les
autres s'ajoutent). Pratique pour transporter son équipe d'une machine à l'autre.

**Duos prêts à l'emploi** : Optimiste & Pessimiste, Taquine & Analyste,
Bouffon & Sceptique, Ironique & Dramatique, Complice & Zen,
Vulgarisatrice & Urgentiste — un clic remplit les deux fiches.

### L'auditeur

Prénom + profil de la personne qui écrit dans la zone de texte. Les présentateurs
s'adressent à elle par son prénom, parlent d'elle comme d'un interlocuteur et
tiennent compte de son profil. L'option **« Tutoyer l'auditeur »** est active par
défaut : le prompt impose le tutoiement (« tu », « ton », « toi ») du début à la
fin, sans aucun vouvoiement — y compris dans les réponses aux questions.

### Langue (français / anglais)

La bascule **FR / EN** en haut de page pilote les trois couches d'un coup :

- **l'interface** — libellés, titres, boutons, aide, et jusqu'aux formats
  (`0,0021 $` en français, `$0.0021` en anglais ; « lundi 5 octobre » /
  « Monday 5 October ») ;
- **les prompts** — consignes système, format des sources et consigne JSON sont
  rédigées dans la langue de l'émission, y compris la requête de recherche
  obtenue à partir d'une question (une recherche en français sur une radio
  anglophone ramenait des articles hors sujet) ;
- **la production** — sources interrogées, langue du script, voix proposées.

Changer de langue repropose les voix du nouveau pays (les prénoms sont
conservés). Le réglage est partagé par les trois pages : le direct, le Replay et
le Récap affichent tous dans la même langue. Le texte déjà archivé (titres,
transcripts) n'est bien sûr pas retraduit — c'est du contenu, pas de
l'interface.

### Thèmes prédéfinis

32 thèmes rangés en 9 familles, chacun avec sa requête de recherche et ses
mots-clés de pertinence :

- **Technologie & IA**, **Actualité France**, **Monde**, **Économie**,
  **Climat & planète**, **Santé & épidémies**, **Risques & fin du monde**
  (effondrement, risque nucléaire, risques liés à l'IA, menaces spatiales),
  **Science & espace**, **Culture & sport**.

Un thème ajouté depuis *Réglages → Sources → Thèmes prédéfinis* devient une chip
sous la zone de question ; cliquer sur une chip en direct met le sujet à la file
pour le bulletin suivant.

## Musique personnelle pendant l’attente

Dans **Direct → Musique pendant la préparation → Choisir un dossier audio**, choisis
un dossier contenant tes MP3, OGG, M4A, WAV, FLAC ou AAC (selon les codecs pris en
charge par ton navigateur). Les sous-dossiers du dossier choisi sont inclus.

- Les fichiers restent dans ton navigateur : **aucun téléversement** et aucune
  copie dans les archives ou le podcast.
- Les pistes s’enchaînent au hasard, sans répétition immédiate si plusieurs
  sont disponibles. Une piste illisible est écartée pour cette attente.
- La musique comble l’attente lorsque l’antenne n’a pas encore de voix prête,
  y compris pendant la recherche et la rédaction ; elle s’arrête immédiatement
  au démarrage des voix, à la pause ou à l’arrêt. Le volume et la sourdine du
  lecteur s’appliquent aussi à la musique.
- Le dossier choisi dans le navigateur doit être **resélectionné après un
  rechargement ou une fermeture de page**. Le nom et le nombre de pistes
  sélectionnées sont affichés, ainsi que le fichier en cours.
- Pour un choix permanent, **Configurer un dossier permanent** ouvre
  Réglages → Sources : saisis le chemin du dossier sur la machine du serveur.
  Ce réglage est conservé. Le dossier navigateur a priorité jusqu’à ce que tu
  cliques sur **Revenir au dossier serveur / aux ambiances**.
- « Aucune musique » coupe aussi les pistes personnelles.

## TTS : quel moteur, quel coût ?

Réglages → Équipe & voix, puis **Comparer les TTS** : la même phrase passe dans
plusieurs moteurs et le tableau donne latence, taille, coût et écoute.

| Moteur | Prix (catalogue du 06/10/2026) | Timings |
| --- | --- | --- |
| **Edge TTS** (défaut) | **gratuit**, sans clé | exacts, mot à mot |
| OpenRouter `fish-audio/s2.1-pro-free:free` | gratuit | estimés |
| `hexgrad/kokoro-82m` | 0,00062 $/1 000 car. | estimés |
| `canopylabs/orpheus-3b-0.1-ft`, `sesame/csm-1b` | 0,007 $/1 000 car. | estimés |
| `google/gemini-3.8-flash-lite-tts` | ≈ 0,0101 $/1 000 car. | estimés |
| `fish-audio/s2.1-pro`, `microsoft/mai-voice-2.1-flash`, `x-ai/grok-voice-tts-1.0` | 0,015 $/1 000 car. | estimés |
| `google/gemini-3.8-flash-tts` | ≈ 0,0151 $/1 000 car. | estimés |
| `google/gemini-3.1-flash-tts-preview` | ≈ 0,0336 $/1 000 car. | estimés |
| `minimax/speech-2.8-hd` | 0,10 $/1 000 car. | estimés |
| `bytedance-seed/seed-audio-1-0` | ≈ 4,17 $/1 000 car. | estimés |

Les tarifs sont lus en direct dans le catalogue OpenRouter (23 moteurs vocaux au
06/10/2026) et normalisés pour 1 000 caractères : les 18 moteurs facturés au
caractère sont exacts, les 4 facturés au token d'audio sont estimés
(≈ 15 caractères lus par seconde, ≈ 25 tokens d'audio par seconde). Un bulletin
de 60 s ≈ 900 caractères. Attention : les modèles Gemini TTS facturés au token
coûtent 10 à 34 fois plus que l'ancien chiffre indiqué ici (0,001 $).

## Replay

Le bouton **Replay** de l'en-tête (page `/replay.html`) liste les émissions
archivées, jour par jour : titre, sujet, question, présentateurs, durée, coût,
recherche par mot-clé et filtre bulletins / questions. Chaque émission se
réécoute dans une **barre de lecture en bas de page — la même que le direct** :
lecture / pause, ±15 s, précédent / suivant, vitesse, volume, barre de
progression. Le transcript s'affiche à droite avec le même surlignage mot à mot
que l'antenne (timings exacts enregistrés avec l'archive), et les sources de
l'émission sont listées en dessous. Le MP3 est téléchargeable.

La corbeille de chaque carte **supprime l'archive** (MP3 + transcript) après
confirmation ; la journée disparaît de la liste quand il ne reste plus rien.
Pratique pour faire le ménage après des essais.

### Mémoire longue : la page Récap

Le bouton **Récap** (page `/digest.html`) relit les archives de la période choisie
(7, 14 ou 30 jours) sans réinterroger les flux : nombre d'émissions, temps d'antenne,
coût, sujets les plus traités, médias les plus cités, journées détaillées — chaque
émission renvoie au Replay. *Générer le récapitulatif* fait écrire par le modèle
rapide une rétrospective de 200 à 260 mots, conservée dans `.data/digest.json`.

### S'abonner au podcast

`/feed.xml` expose les dernières émissions en RSS 2.0 (enclosures MP3, durée, date),
prêt à coller dans un lecteur de podcasts — le moyen le plus simple de réécouter le
replay depuis un téléphone ou une enceinte connectée.

## Émissions archivées

Chaque segment est écrit sur le disque (désactivable dans les réglages) :

```
shows/
  2026-10-05/
    03-45-56_ia-tech_bulletin.mp3     ← audio concaténé des deux voix
    03-45-56_ia-tech_bulletin.json    ← transcript, répliques, timings mot à mot, sources, coûts
    04-12-03_grippe-aviaire-question_question.mp3
```

Nom : `HH-MM-SS_<thème-ou-question>_<bulletin|question|debat>.mp3` — un dossier par
jour, l'heure en tête, le sujet ensuite. Les compteurs cumulés sont enregistrés
à part dans `.data/stats.json`, la mémoire éditoriale dans `.data/played.json` et
le dernier récapitulatif dans `.data/digest.json`.

## API

| Route | Rôle |
| --- | --- |
| `GET /api/state` | réglages publics, catalogue, voix, stats, historique |
| `GET /api/models?kind=llm\|tts&q=` | modèles et tarifs OpenRouter |
| `GET /api/locale` | langue courante seule (Replay et Récap, sans charger l'état complet) |
| `POST /api/settings` · `POST /api/settings/check` | écriture des réglages · test de clé |
| `POST /api/segment/plan` | `{mode:"news"\|"question"\|"debate", topic?, question?}` → news + script (ou débat) |
| `POST /api/segment/render` | `{id}` → voix, concaténation, archivage |
| `GET /api/audio/:id` | MP3 (requêtes `Range` gérées pour le seek) |
| `GET /api/shows?day=AAAA-MM-JJ` | journées archivées + émissions du jour (transcript, répliques, sources) |
| `GET /api/shows/:day/:fichier.mp3` | MP3 archivé, découpé sur le disque au fil des requêtes `Range` |
| `DELETE /api/shows/:day/:fichier.mp3` | supprime une archive (MP3 + JSON, dossier du jour compris s'il devient vide) |
| `POST /api/templates` · `DELETE /api/templates/:id` | créer/modifier · supprimer un gabarit perso |
| `GET /api/team/export` · `POST /api/team/import` | export JSON de l'équipe · import JSON |
| `POST /api/tts/preview` · `POST /api/tts/compare` | aperçu voix · comparateur de moteurs |
| `GET /feed.xml` | flux podcast RSS des dernières émissions (enclosures MP3) |
| `GET /api/digest?days=N` · `POST /api/digest` | agrégats de la période · récapitulatif rédigé par le modèle rapide |
| `DELETE /api/memory` | vide la mémoire éditoriale de la journée |

## Structure

```
src/
  index.ts      serveur Bun, port, warm-up du catalogue
  routes.ts     API HTTP + fichiers statiques
  radio.ts      pipeline news → script → voix, store des segments
  llm.ts        prompts, parsing JSON, dialogue de repli sans LLM
  news.ts       RSS/Atom, Google News, pertinence, lecture d'articles
  tts.ts        Edge + OpenRouter, durées MP3 exactes, synthèse duo
  archive.ts    écriture des émissions sur le disque
  shows.ts      lecture et suppression des archives pour le replay (liste, transcript, chemins)
  memory.ts     mémoire éditoriale de la journée (anti-redite)
  feed.ts       flux podcast RSS des archives
  digest.ts     mémoire longue : agrégats + récapitulatif de la période
  config.ts     thèmes, flux, langues, présentateurs et gabarits par défaut
  settings.ts   persistance des réglages (dont les gabarits persos)
public/
  index.html    interface guidée (Bootstrap 5 + verre violet sobre)
  replay.html   page des émissions archivées
  digest.html   page Récap (mémoire longue)
  styles.css    glassmorphisme sombre
  js/app.js     console d'antenne, file, réglages, gabarits, comparateur
  js/replay.js  liste des archives, transcript synchronisé, lecteur
  js/digest.js  agrégats de la période, récapitulatif généré
  js/transcript.js  alignement mot à mot et estimation des timings
  js/i18n.js        dictionnaire FR/EN de l'interface (bascule de langue)
  js/waiting-music.js  lecture aléatoire annulable des pistes d’attente
tests/
  core.test.ts      regroupement, dialogue, slug, transcript
  features.test.ts  mémoire, débat, podcast, mémoire longue, prompts bilingues
  i18n.test.ts      archive réellement écrite, dictionnaire FR/EN complet
```

## Notes

- Les news viennent de flux RSS publics : usage personnel, non commercial.
- Edge TTS s'appuie sur le service de lecture à voix haute de Microsoft, sans
  clé — pensez à garder un usage raisonnable.
- Les modèles `:free` d'OpenRouter sont soumis à des limites de débit.
- Le lecteur du direct et celui du replay partagent la même barre en bas de page,
  avec une sourdine accessible au clavier et sur mobile.
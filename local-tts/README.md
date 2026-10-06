# Chatterbox Multilingual V3 local

Installé dans `.venv-chatterbox` (Python 3.11, PyTorch 2.6 CUDA 12.4), poids V3 dans `.local-tts/cache` (~3 Go). Aucun abonnement TTS ; consommation électrique/GPU non comptée dans les coûts API.

## Lancer

```bash
bun run tts:local
bun run dev
```

Le bridge écoute uniquement `127.0.0.1:8765`. `GET /health` donne chargement, GPU et références. Dans **Réglages → Équipe & voix → Moteur**, choisir **Chatterbox Multilingual V3**. Le modèle est gardé en mémoire GPU, inférence sérialisée (une génération à la fois). FFmpeg doit être dans le PATH.

La commande `tts:local` est configurée pour cette installation Windows ; sur Linux/macOS : `.venv-chatterbox/bin/python local-tts/server.py`.

## Réinstaller

```bash
uv venv --python 3.11 .venv-chatterbox
uv pip install --python .venv-chatterbox/Scripts/python.exe torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
uv pip install --python .venv-chatterbox/Scripts/python.exe -r local-tts/requirements.lock
```

La version de Chatterbox est fixée par commit dans `requirements.lock`. Le téléchargement initial des poids est automatique ; les relancements réutilisent le cache. Dépôt officiel : https://github.com/resemble-ai/chatterbox.

## Voix

Deux références synthétiques françaises de départ sont préparées depuis Edge Denise/Henri, dans `.local-tts/voices/host-1.wav` et `host-2.wav`. Pas de clonage de personne réelle. Elles peuvent être remplacées depuis les deux champs WAV de l'interface (3–30 s, 10 Mo max). Utiliser uniquement des voix autorisées. Les références et les modèles sont ignorés par Git.

Le modèle conserve son watermark Perth. La fidélité de la voix et la qualité française restent à juger à l'écoute. Il ne fournit pas de timings de mots : le transcript est estimé sur la durée réelle.

## Performances mesurées

RTX 4060 Ti 16 Go, avant ajout des références : une phrase française de 101 caractères.

- Première synthèse : 24,8 s pour 5,8 s d'audio.
- Synthèse à chaud : 8,4 s pour 5,9 s d'audio (facteur temps réel 1,43).

Ce n'est donc **pas une garantie de radio sans blancs**. Le tampon initial de 3 clips absorbe des variations, mais ne corrige pas un débit de génération durablement inférieur au débit de lecture. Réduire la vitesse de lecture, augmenter l'avance ou sélectionner Fish/Edge pour une session longue.

`reports/chatterbox-benchmark.json` contient les mesures ; `bun run scripts/benchmark-local.ts` permet de les refaire (moteur déjà lancé).

Le bridge coupe les longues répliques en phrases/blocs de 45 mots ; une annulation coupe les blocs suivants, mais ne peut interrompre instantanément un kernel GPU en cours. Aucun résultat annulé ne doit reprendre l'antenne.

# Radio continue — livraison

## Fonctionnement

- Tampon initial de 3 clips, puis maintien des segments d'avance configurés.
- Clips prêts conservés pendant une question ; réponse prête en tête de file, jouée après le clip courant. Option d'interruption immédiate.
- Pause annule la génération active et garde clips/demandes ; Stop vide l'antenne, les complétions tardives sont rejetées.
- Sujet changé : anciennes préparations invalidées, nouveau sujet après le clip courant.
- Essais bornés, pause après trois échecs. Aucun délai artificiel entre clips prêts.
- Annonce courte Edge de 10 secondes maximum seulement quand le tampon est vide pendant la synthèse. Elle ne garantit pas que la génération sera terminée en dix secondes.
- Modes actualité/exploration/hybride et fréquence de recherche indépendante (cache par sujet/langue/flux).
- Six extraits réellement entendus en contexte ; angles déjà préparés séparés pour éviter les redondances. La mémoire reste en page, pas persistée entre rechargements.
- Coût API par minute et projection horaire après une minute produite dans cette page ; compteur cumulatif conservé séparément. Coûts des appels abandonnés/échoués, électricité GPU non inclus.
- Réglages humour, désaccord, technicité, longueur et interpellations.
- Prix négatifs de routeurs retirés, catalogue complet et modèle actif conservé dans le sélecteur, lecteur mobile compact.

## Moteurs

Hy3 : 0,0825 $/M tokens entrée, 0,33 $/M sortie, test JSON 4,7 s / 0,000068 $. Premier essai à raisonnement activé vide ; corrigé avec reasoning effort none.

Fish gratuit : 4,122 / 4,040 s sur 131 caractères ; Kokoro : 3,076 / 5,049 s, 0,00062 $/1k caractères. Ces essais ne prouvent pas un classement global de latence/qualité. Fish ne fournit pas de catalogue de voix ; deux timbres distincts non garantis.

Grok testé : 1,453 s sur 101 caractères, 0,001515 $. Tarif 0,015 $/1k caractères (~0,81 $/h à 900 car/min). Non activé comme secours payant.

Gemini TTS : essais en échec, format MP3 non accepté (PCM requis). Non retenu ; pas de conversion PCM ajoutée.

Chatterbox V3 installé, GPU CUDA reconnu, ~3 Go de poids. Bridge loopback 8765, environnement Python isolé, références initiales synthétiques Denise/Henri (pas de personne réelle). Cache des conditionnements ajouté ; erreur de deepcopy de tenseurs non-leaf corrigée via detach/clone, synthèses retestées.

Mesures Chatterbox :
- Phrase 101 caractères avant références : 24,8 s à froid, 8,4 s à chaud pour ~5,9 s d'audio.
- Deux vrais clips à deux voix : ~56 s de synthèse pour 27–31 s d'audio, avant cache des références.
- Après correction/cache : prévisualisations via l'API de la radio 8,532 / 6,614 s sur une phrase de 45 caractères.

**Chatterbox fonctionne mais n'est pas assez rapide dans cette configuration pour promettre une antenne sans blancs en permanence.** Le tampon de trois clips ne change pas un déficit durable de débit. Fish/Edge restent les options rapides ; le coût local API est 0 mais le GPU consomme de l'électricité.

## Vérification

- Typecheck et 35 tests réussis (moteur, annulations, file prioritaire, tampon 3, coûts, contexte, cache recherches, modes).
- Compilation Python réussie ; bridge health prêt sur RTX 4060 Ti 16 Go, deux références.
- Parcours navigateur : Hy3 + Fish en exploration, génération/audio/surlignage, question prioritaire et pause, affichage du coût/min/h ; Chatterbox rend/archivage et lecture des deux clips locaux dans le Replay.
- API preview locale réussie deux fois après dernière réparation Python, coût TTS 0 ; annonce Edge HTTP 200 et lecture blob.
- Vue mobile 390×844 vérifiée ; pas de débordement horizontal.
- Pas de validation d'une session de plusieurs heures, pas de transcription automatique de contrôle de l'audio, qualité vocale non notée subjectivement.

## Démarrage

```bash
bun run tts:local
bun run dev
```

Instance de validation : http://127.0.0.1:3003 (l'ancienne instance 3002 appartient à un autre processus et n'a pas été stoppée). Moteur sélectionné : Chatterbox local, rédaction Hy3, repli Edge gratuit, tampon 3. Voir local-tts/README.md.

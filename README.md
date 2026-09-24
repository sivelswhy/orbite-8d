# Orbite 8D

Transforme un morceau en vidéo TikTok (1080×1920) : le son tourne autour de la tête (effet 8D) sur un paysage animé.

Interface statique avec une petite API Node pour les liens YouTube.

## Lancer en local

```sh
brew install yt-dlp ffmpeg
node server.js
# puis http://localhost:8000
```

## Déployer

Le serveur YouTube nécessite un hébergement qui autorise `yt-dlp` et `ffmpeg`. Vercel ne fournit pas ces binaires par défaut ; pour un déploiement statique, garde uniquement les imports de fichiers et de liens audio directs.

## Fonctionnement

- **Son** : mp3 / m4a / wav décodé dans le navigateur (Web Audio), depuis un fichier, un lien direct (liens Dropbox convertis automatiquement) ou un lien YouTube. L’API locale utilise `yt-dlp` et `ffmpeg` pour renvoyer un MP3 ; utilise uniquement des contenus que tu as le droit de télécharger.
- **8D** : `PannerNode` HRTF en orbite ; basses (< 120 Hz) gardées au centre ; vitesse, intensité, réverbération (convolution) réglables.
- **Paysages** : Nuit boréale, Horizon néon, Sommets à l'aube, Mer de lune, Dunes — réactifs aux basses.
- **Texte** : badge « 8D AUDIO », titre, artiste, schéma de la position du son.
- **Extrait** : début au choix, 15 s à 3 min, ou morceau entier.
- **Export** : `canvas.captureStream` + `MediaRecorder`, MP4 si le navigateur le permet (Safari, Chrome récent), sinon WebM. Enregistrement en temps réel, onglet au premier plan.

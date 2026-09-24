# Orbite 8D

Transforme un morceau en vidéo TikTok (1080×1920) : le son tourne autour de la tête (effet 8D) sur un paysage animé.

Interface statique avec une petite API Node locale pour les liens YouTube. Le projet tourne uniquement en local : YouTube bloque yt-dlp depuis les IP d’hébergeurs comme Vercel.

## Lancer en local

```sh
brew install yt-dlp ffmpeg   # requis pour les liens YouTube
node server.js
# puis http://localhost:8000
```

Variables facultatives : `YTDLP_PATH` et `FFMPEG_PATH` (binaires hors du PATH), `YTDLP_COOKIES` (fichier cookies.txt si YouTube demande une connexion). En cas d’erreur YouTube, mets yt-dlp à jour : `brew upgrade yt-dlp`.

## Fonctionnement

- **Son** : mp3 / m4a / wav décodé dans le navigateur (Web Audio), depuis un fichier, un lien direct (liens Dropbox convertis automatiquement) ou un lien YouTube. L’API locale utilise `yt-dlp` et `ffmpeg` pour renvoyer un MP3 ; utilise uniquement des contenus que tu as le droit de télécharger.
- **8D** : `PannerNode` HRTF en orbite ; basses (< 120 Hz) gardées au centre ; vitesse, intensité, réverbération (convolution) réglables.
- **Paysages** : Nuit boréale, Horizon néon, Sommets à l'aube, Mer de lune, Dunes — réactifs aux basses.
- **Texte** : badge « 8D AUDIO », titre, artiste, schéma de la position du son.
- **Extrait** : début au choix, 15 s à 3 min, ou morceau entier.
- **Intro** : carte « Put on your headphones » de 1,5 s avant la musique, avec une icône AirPods Pro (SVG Repo, `assets/airpods.svg`).
- **Export** : `canvas.captureStream` + `MediaRecorder`, MP4 si le navigateur le permet (Safari, Chrome récent), sinon WebM. Enregistrement en temps réel, onglet au premier plan.

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
- **Paysages** : vidéos verticales de villes de nuit (`assets/videos/*.mp4`, 1080×1920, H.264, sans son), enchaînées automatiquement en ordre aléatoire, avec un fondu entre les clips et un léger zoom sur les basses. Ces vidéos ne sont pas versionnées dans git.
- **Affichage** : aucun texte sur la vidéo, seulement le filigrane 8dsongslive ; schéma de la tête en option.
- **Paroles** : paroles synchronisées cherchées sur [lrclib.net](https://lrclib.net) (titre + artiste), affichées au centre ligne par ligne avec fondu ; barre de recherche pour chercher à la main et liste des versions trouvées ; décalage réglable, ou paroles LRC collées à la main.
- **Extrait** : début au choix, 15 s à 3 min, ou morceau entier.
- **Intro** : carte « Put on your headphones » de 1,5 s avant la musique, avec une icône AirPods Pro (SVG Repo, `assets/airpods.svg`).
- **TikTok** : après l'export, « Publier sur TikTok » ouvre un Chromium (Playwright) qui envoie la vidéo, remplit la légende et clique sur « Publier » ; la fenêtre se ferme une fois la vidéo publiée. Décoche « Publier automatiquement » pour vérifier et cliquer toi-même. Connexion à TikTok faite une fois à la main ; session gardée dans `~/.orbite-8d/tiktok-profile`. Première installation : `npm install && npx playwright install chromium`. Si TikTok change sa page, corrige `SELECTORS` dans `api/tiktok.js`.
- **Export** : `canvas.captureStream` + `MediaRecorder`, MP4 si le navigateur le permet (Safari, Chrome récent), sinon WebM. Enregistrement en temps réel, onglet au premier plan.

## Licence

Usage personnel et non commercial uniquement ; redistribution interdite. Voir [LICENSE](LICENSE). Les musiques, paroles et vidéos utilisées restent la propriété de leurs auteurs.

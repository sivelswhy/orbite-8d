# Orbite 8D

Petit outil perso pour faire des vidéos TikTok en 8D : le son tourne autour de la tête, avec des paysages de nuit derrière et les paroles au milieu.

Ça tourne en local seulement (YouTube bloque yt-dlp sur les serveurs type Vercel).

## Installation

```sh
brew install yt-dlp ffmpeg
npm install
npx playwright install chromium
node server.js
```

Puis ouvrir http://localhost:8000

Si YouTube ne marche plus, `brew upgrade yt-dlp` règle le problème en général.

## Utilisation

1. Charger un morceau : fichier, lien direct, Dropbox ou YouTube.
2. Régler le 8D (vitesse, intensité, réverb) et choisir l'extrait.
3. Les paroles sont trouvées toutes seules sur lrclib.net. Sinon on peut les chercher à la main ou coller un fichier LRC, et corriger le décalage (le bouton « Sync auto » essaie de le trouver tout seul).
4. Exporter. L'enregistrement se fait en temps réel, il faut garder l'onglet ouvert devant.
5. Publier sur TikTok : une fenêtre Chromium s'ouvre, envoie la vidéo avec la légende et publie. La première fois il faut se connecter à TikTok dans cette fenêtre.

Les vidéos de fond vont dans `assets/videos/` (mp4 vertical 1080×1920, sans son). Elles ne sont pas dans git.

Si TikTok change sa page d'upload, les sélecteurs à corriger sont dans `api/tiktok.js`.

## Licence

Usage perso uniquement, pas de redistribution. Voir [LICENSE](LICENSE). Les musiques, paroles et vidéos appartiennent à leurs auteurs.

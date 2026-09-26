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

1. Charger un morceau : fichier, lien direct, Dropbox, YouTube ou Spotify. Spotify ne donne pas accès au son : le serveur lit le titre et l'artiste du lien Spotify, puis prend le premier résultat YouTube pour ce morceau.
2. Régler le 8D (vitesse, intensité, réverb) et choisir l'extrait. Il se place tout seul sur le refrain (d'après les paroles, sinon d'après le son), marqué d'un point rouge sur la forme d'onde comme sur Instagram. En glissant la sélection près du point, elle s'y cale, et elle se joue dès qu'on la lâche. Le bouton « Aller au refrain » relance la recherche.
3. Les paroles sont trouvées toutes seules sur lrclib.net. Sinon on peut les chercher à la main ou coller un fichier LRC, et corriger le décalage (le bouton « Sync auto » essaie de le trouver tout seul).
4. Exporter. La toute première image de la vidéo (1/30 s, invisible à la lecture) est une couverture avec le titre et l'artiste : TikTok la prend comme miniature sur le profil. Case « Couverture TikTok » dans Affichage pour la retirer. Le rendu est accéléré (WebCodecs + ffmpeg du serveur local) : une vidéo de 30 s sort en quelques secondes. Sur un navigateur sans WebCodecs, l'enregistrement se fait en temps réel et il faut garder l'onglet ouvert devant.
5. Publier sur TikTok : par défaut, chaque export est publié tout seul à la fin (case « Publier sur TikTok à la fin de l'export », à décocher pour publier à la main). Chromium tourne alors en arrière-plan, sans fenêtre, avec la légende par défaut. La première fois, une fenêtre s'ouvre pour se connecter à TikTok.

Les vidéos de fond vont dans `assets/videos/` (mp4 vertical 1080×1920, sans son). Elles ne sont pas dans git.

Si TikTok change sa page d'upload, les sélecteurs à corriger sont dans `api/tiktok.js`.

## Licence

Usage perso uniquement, pas de redistribution. Voir [LICENSE](LICENSE). Les musiques, paroles et vidéos appartiennent à leurs auteurs.

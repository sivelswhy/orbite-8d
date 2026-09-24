# Orbite 8D

Transforme un morceau en vidéo TikTok (1080×1920) : le son tourne autour de la tête (effet 8D) sur un paysage animé.

Interface statique avec une petite API Node pour les liens YouTube.

## Lancer en local

```sh
brew install yt-dlp ffmpeg   # requis pour les liens YouTube
node server.js
# puis http://localhost:8000
```

Variables facultatives : `YTDLP_PATH` et `FFMPEG_PATH` (binaires hors du PATH), `YTDLP_COOKIES` (fichier cookies.txt si YouTube demande une connexion).

## Déployer

Google bloque yt-dlp sur les IP Vercel. Sur Vercel, `/api/youtube-audio` redirige donc le navigateur vers un serveur yt-dlp externe (ton Mac, un Raspberry Pi, un VPS…). L’URL est signée en HMAC pour que ce serveur ne réponde qu’aux requêtes venant du site.

1. Sur la machine qui télécharge (IP résidentielle de préférence) :

   ```sh
   brew install yt-dlp ffmpeg cloudflared
   YTDLP_BACKEND_SECRET=<secret> node server.js
   cloudflared tunnel --url http://localhost:8000   # affiche une URL https://….trycloudflare.com
   ```

2. Dans Vercel → Settings → Environment Variables, puis redéploie :
   - `YTDLP_BACKEND_URL` : l’URL https du tunnel ou du serveur
   - `YTDLP_BACKEND_SECRET` : le même secret (`openssl rand -hex 32`)

L’URL `trycloudflare.com` change à chaque redémarrage du tunnel. Pour une URL fixe, utilise un tunnel Cloudflare nommé ou un VPS. Sans ces variables, l’API répond 503 sur Vercel.

## Fonctionnement

- **Son** : mp3 / m4a / wav décodé dans le navigateur (Web Audio), depuis un fichier, un lien direct (liens Dropbox convertis automatiquement) ou un lien YouTube. L’API locale utilise `yt-dlp` et `ffmpeg` pour renvoyer un MP3 ; utilise uniquement des contenus que tu as le droit de télécharger.
- **8D** : `PannerNode` HRTF en orbite ; basses (< 120 Hz) gardées au centre ; vitesse, intensité, réverbération (convolution) réglables.
- **Paysages** : Nuit boréale, Horizon néon, Sommets à l'aube, Mer de lune, Dunes — réactifs aux basses.
- **Texte** : badge « 8D AUDIO », titre, artiste, schéma de la position du son.
- **Extrait** : début au choix, 15 s à 3 min, ou morceau entier.
- **Export** : `canvas.captureStream` + `MediaRecorder`, MP4 si le navigateur le permet (Safari, Chrome récent), sinon WebM. Enregistrement en temps réel, onglet au premier plan.

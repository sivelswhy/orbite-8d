# Orbite 8D

Transforme un morceau en vidéo TikTok (1080×1920) : le son tourne autour de la tête (effet 8D) sur un paysage animé.

Site statique, sans build : `index.html`, `style.css`, `app.js`.

## Lancer en local

```sh
python3 -m http.server 8000
# puis http://localhost:8000
```

## Déployer

Importer le dossier dans Vercel (preset « Other », pas de commande de build), ou `vercel --prod`.

## Fonctionnement

- **Son** : mp3 / m4a / wav décodé dans le navigateur (Web Audio). Un son démo est synthétisé au démarrage.
- **8D** : `PannerNode` HRTF en orbite ; basses (< 120 Hz) gardées au centre ; vitesse, intensité, réverbération (convolution) réglables.
- **Paysages** : Nuit boréale, Horizon néon, Sommets à l'aube, Mer de lune, Dunes — réactifs aux basses.
- **Texte** : badge « 8D AUDIO », titre, artiste, schéma de la position du son.
- **Extrait** : début au choix, 15 s à 3 min, ou morceau entier.
- **Export** : `canvas.captureStream` + `MediaRecorder`, MP4 si le navigateur le permet (Safari, Chrome récent), sinon WebM. Enregistrement en temps réel, onglet au premier plan.

# Sticky Move Bot

Bot Discord qui permet de :
- **`/move`** — déplacer tous les membres d'un salon vocal vers un autre
- **`/stick` / `/unstick` / `/stick-status`** — verrouiller un salon vocal
- **Musique** : `/play`, `/skip`, `/stop`, `/pause`, `/resume`, `/queue`, `/nowplaying`, `/volume`, `/settings`

> ⚠️ Limite technique Discord : un bot peut **déplacer** quelqu'un déjà connecté en vocal vers un autre salon, mais il ne peut **jamais forcer quelqu'un à rejoindre un vocal** s'il s'est complètement déconnecté.

### Musique (Pterodactyl)

- L'egg / l'image doit avoir **FFmpeg** (la plupart des eggs Discord Node l'ont). Sinon définis `FFMPEG_PATH`.
- Permissions bot : **Connect**, **Speak**, **Move Members**, **View Channels**
- `/play` accepte YouTube, YouTube Music, Spotify / Apple Music / Deezer (résolus vers YouTube Music), ou une recherche texte
- Le bot quitte le vocal sur `/stop` ou s'il ne reste plus personne en vocal

---

## 1. Prérequis

- [Node.js](https://nodejs.org/) version 18 ou plus (vérifie avec `node -v`)
- Un compte Discord avec les droits administrateur sur ton serveur

---

## 2. Créer l'application Discord et le bot

1. Va sur https://discord.com/developers/applications
2. Clique **New Application**, donne-lui un nom (ex: `StickyMoveBot`)
3. Dans le menu de gauche, va dans **Bot**
4. Clique **Reset Token** (ou **Add Bot**), puis **Copy** pour récupérer le **token** → garde-le secret, c'est le mot de passe du bot
5. Toujours dans l'onglet **Bot**, active les intents nécessaires (scroll en bas) :
   - **Server Members Intent** → pas obligatoire ici mais utile
   - **Voice States** sont inclus par défaut dans les intents non privilégiés, rien à activer de spécial pour ça
6. Va dans l'onglet **OAuth2 → URL Generator** :
   - Coche **`bot`** et **`applications.commands`**
   - Dans "Bot Permissions", coche : **Move Members**, **View Channels**, **Connect**
   - Copie l'URL générée en bas, colle-la dans ton navigateur, choisis ton serveur et invite le bot

7. Récupère aussi :
   - Le **Client ID** (onglet **General Information** → "Application ID")
   - L'**ID de ton serveur** (dans Discord, active le mode développeur : `Réglages utilisateur → Avancé → Mode développeur`, puis clic droit sur l'icône du serveur → "Copier l'ID du serveur")

---

## 3. Installer le projet

Récupère les fichiers du dossier `sticky-move-bot` fourni, puis dans un terminal :

```bash
cd sticky-move-bot
npm install
```

Renomme `.env.example` en `.env` et remplis-le :

```env
BOT_TOKEN=le_token_copié_à_l_étape_2
CLIENT_ID=le_client_id_copié_à_l_étape_2
GUILD_ID=l_id_de_ton_serveur
```

---

## 4. Enregistrer les commandes slash

Cette étape n'est à faire qu'une fois (ou à chaque fois que tu modifies les commandes) :

```bash
npm run deploy
```

Tu dois voir `Commandes enregistrees avec succes.`

---

## 5. Lancer le bot

```bash
npm start
```

Tu dois voir `Connecte en tant que StickyMoveBot#XXXX`. Le bot est en ligne tant que ce terminal reste ouvert.

---

## 6. Utilisation

- `/move source:#Salon-A destination:#Salon-B` → déplace tout le monde de A vers B, une seule fois.
- `/stick salon:#Salon-A` → verrouille le salon A. Tous ceux qui y sont déjà + tous ceux qui le rejoignent ensuite seront ramenés automatiquement s'ils tentent de partir dans un autre salon vocal.
- `/unstick salon:#Salon-A` → désactive le verrouillage.
- `/stick-status` → liste les salons verrouillés et combien de membres sont suivis.

Seuls les membres ayant la permission Discord **"Déplacer des membres"** peuvent utiliser ces commandes.

---

## 7. Garder le bot en ligne 24/7 (optionnel)

Pour l'instant le bot tourne uniquement pendant que ton terminal est ouvert. Pour le faire tourner en continu sur ta machine, tu peux utiliser [PM2](https://pm2.keymetrics.io/) :

```bash
npm install -g pm2
pm2 start src/index.js --name sticky-move-bot
pm2 save
```

Pour l'héberger en permanence sans garder ton PC allumé, il faudra le déployer sur un petit serveur (VPS) ou une machine dédiée — dis-moi si tu veux un tuto pour ça aussi.

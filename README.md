<div align="center">

<img src="./assets/ditto.png" width="112" alt="Ditto" />

# Ditto

Voice tools, a picture captcha and tiered roles for Discord.

<a href="https://github.com/da0t-exe/Ditto/releases"><img src="./assets/badges/version.svg" alt="version 0.2.0" /></a>
<img src="./assets/badges/node.svg" alt="node 20+" />
<img src="./assets/badges/discordjs.svg" alt="discord.js 14" />
<a href="LICENSE"><img src="./assets/badges/license.svg" alt="license MIT" /></a>

</div>

## Features

- **Picture captcha** — newcomers pick the right photos in a 3×3 grid before they get in. No grid is ever served twice.
- **Roles** — a colour and game picker, and tier titles that keep profiles tidy.
- **Voice** — `/move` `/gather` `/split` `/disconnect` `/shake` `/lock`, and rooms that reset when they empty.
- **English & French**, set up from Discord with `/setup`.

Music is on the way.

## Quick start

```bash
git clone https://github.com/da0t-exe/Ditto.git
cd Ditto
npm install
cp .env.example .env
npm start
```

Put your bot token in `.env`. Ditto needs Node.js 20+ and the **Server Members** intent.

Invite it with the link below (use your application ID), drag its role to the top of the role list, then run `/setup`.

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099798006800
```

To update: `git pull && npm install && npm start`.

## License

[MIT](LICENSE). The Ditto artwork is a fan drawing of a Pokémon © Nintendo / Creatures / GAME FREAK and is not covered by this license. Captcha photos come from [Open Images](https://storage.googleapis.com/openimages/web/index.html) (CC BY 2.0).

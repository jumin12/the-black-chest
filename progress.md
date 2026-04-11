Original prompt: Using three.js as a single index.html file with amazing graphics create a multiplayer pirate game. The world should be randomly generated as the players explore it, the world should be mostly ocean with islands. The player can customize and build their own pirate ships with parts and items they find, the ships should be large enough to have a crew and there should be a crew with the camera being RTS like in a fixed position.

## Completed

- **Server (server.js)**: WebSocket multiplayer server with HTTP static file serving, player state sync at 20Hz, world seed sharing, ship customization broadcast, chat, cannonball sync
- **Water Shader**: Custom Gerstner wave vertex shader with 5 wave layers, Fresnel reflections, subsurface scattering, foam, specular highlights
- **Sky System**: Procedural sky dome with sun, clouds, horizon gradient
- **Procedural World**: Chunk-based generation using simplex noise, islands with multi-layer terrain (sand/grass/rock), palm trees with curved trunks and drooping leaves, rocks, collectible crates
- **Ship Builder**: 3 hull types (Sloop, Brigantine, Galleon), customizable hull material, sails, cannons, figurehead with iron cost system
- **Ship Rendering**: Extruded hull shape, deck, rails, stern cabin, animated sails with wind billow, pirate flag, figurehead
- **Crew System**: Crew members on deck with role-based positioning (captain at helm, gunner at cannons, sailor at sails), idle wandering animation
- **RTS Camera**: Fixed elevated angle, WASD ship control, arrow keys/middle-mouse pan, scroll zoom, camera gently returns to ship
- **Combat**: Cannon firing (spacebar), projectile physics with gravity, water splash particles on impact
- **Multiplayer**: WebSocket connection, other player ships rendered with interpolated position, chat system, cannon sync
- **UI**: HUD (coords, speed, health, wind), minimap with island/player markers, ship builder panel, inventory panel, crew panel, chat box, notifications
- **World Items**: Collectible crates on islands containing wood/cloth/iron/gold, proximity pickup

## TODOs / Suggestions for next agent

- Add ship-to-ship collision damage
- Island docking mechanic for better item collection
- Enemy NPC ships with AI patrol routes
- Trading system at island ports
- Ship health/repair system using collected materials
- More crew roles and crew recruitment at islands
- Weather system (storms, fog, rain)
- Day/night cycle
- Sound effects and ambient ocean audio
- Ship wake/trail particles behind moving ships

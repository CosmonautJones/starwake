// Deployment settings for a hosted copy of Starwake.
//
// RELAY_URL is the WebSocket relay that "Online" multiplayer connects to, for example
//   export const RELAY_URL = 'wss://starwake-relay.onrender.com/relay';
// Leave it empty when the game is served by server/server.mjs, which has its own /relay.
// A player's own server setting and a ?relay= link still take priority over this.
export const RELAY_URL = '';

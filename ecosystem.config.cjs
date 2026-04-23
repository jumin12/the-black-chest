/**
 * PM2: keeps the WebSocket game server up if Node exits (uncaughtException, OOM, etc.).
 * Usage: npm i -g pm2 && pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [{
    name: 'playground-ws',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    max_restarts: 100,
    min_uptime: 5000,
    max_memory_restart: '900M',
    listen_timeout: 10000,
    kill_timeout: 5000,
    env: { NODE_ENV: 'production' }
  }]
};

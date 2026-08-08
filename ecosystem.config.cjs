/**
 * PM2 process file.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs ponsy-stats
 *   pm2 restart ponsy-stats
 *
 * The .cjs extension is required, not stylistic. PM2 loads this file with
 * `require`, but package.json declares "type": "module", which makes every .js
 * file an ES module where `module.exports` does not exist. The explicit .cjs
 * extension opts this one file back into CommonJS.
 *
 * Cluster mode would be safe here — the service is stateless and holds no
 * scheduler — but it is pointless: every response is served from a 30s cache
 * and the work is waiting on upstream I/O, not CPU. One fork keeps the cache
 * unified; two would double the upstream request rate for no gain.
 */
module.exports = {
  apps: [
    {
      name: 'ponsy-stats',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      time: true, // timestamps in pm2 logs
      env: { NODE_ENV: 'production' },
    },
  ],
}

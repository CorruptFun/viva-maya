module.exports = {
  apps: [
    {
      name: "viva-ton-bot",
      script: "bot/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};

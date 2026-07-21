module.exports = {
  apps: [
    {
      name: "viva-maya-bot",
      script: "bot/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};

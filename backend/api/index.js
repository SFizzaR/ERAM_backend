const serverless = require('@vendia/serverless-express');
const app = require('../server');  // import your express app

module.exports = serverless({ app });

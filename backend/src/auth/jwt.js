const jwt = require('jsonwebtoken');
const sign = (payload, secret, expiresIn='7d') => jwt.sign(payload, secret, { expiresIn });
const verify = (token, secret) => jwt.verify(token, secret);
module.exports = { sign, verify };

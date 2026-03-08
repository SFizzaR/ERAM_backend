// utils/crypto.js
const crypto = require('crypto');
require('dotenv').config();

const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes
const HMAC_KEY = Buffer.from(process.env.HMAC_KEY, 'hex');     // 32 bytes
if (ENC_KEY.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (hex)');
if (HMAC_KEY.length !== 32) throw new Error('HMAC_KEY must be 32 bytes (hex)');

const IV_LEN = 12; // recommended for GCM

function encrypt(text) {
    if (text === null || text === undefined) return null;
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`; // store iv:tag:ct
}

function decrypt(payload) {
    if (!payload) return null;
    const [ivHex, tagHex, encryptedHex] = payload.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(encryptedHex, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
}

// Deterministic keyed hash for lookups (HMAC)
function hashForLookup(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();
    return crypto.createHmac('sha256', HMAC_KEY).update(normalized).digest('hex');
}

module.exports = { encrypt, decrypt, hashForLookup };

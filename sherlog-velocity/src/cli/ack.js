#!/usr/bin/env node
/**
 * sherlog:ack - Acknowledge a gap with a reason and optional expiry
 * 
 * Usage:
 *   npm run sherlog:ack -- --gap="missing_verification" --reason="Defer to v2" --expiry="30d"
 *   npm run sherlog:ack -- --list
 *   npm run sherlog:ack -- --clear-expired
 */

const fs = require('fs');
const path = require('path');

const ACK_FILE = path.join(__dirname, '../../data/acknowledgments.json');

function loadAcknowledgments() {
    if (!fs.existsSync(ACK_FILE)) {
        return { acknowledgments: [] };
    }
    return JSON.parse(fs.readFileSync(ACK_FILE, 'utf-8'));
}

function saveAcknowledgments(data) {
    const dir = path.dirname(ACK_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ACK_FILE, JSON.stringify(data, null, 2));
}

function parseExpiry(expiryStr) {
    if (!expiryStr) return null;

    const match = expiryStr.match(/^(\d+)(d|w|m)$/);
    if (!match) {
        console.error('Invalid expiry format. Use: 7d, 2w, or 1m');
        process.exit(1);
    }

    const [, num, unit] = match;
    const days = unit === 'd' ? parseInt(num) : unit === 'w' ? parseInt(num) * 7 : parseInt(num) * 30;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    return expiry.toISOString();
}

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const [key, ...valueParts] = arg.slice(2).split('=');
            args[key] = valueParts.join('=') || true;
        }
    }
    return args;
}

function getExpiredAcks(acks) {
    const now = new Date();
    return acks.filter(a => a.expires_at && new Date(a.expires_at) < now);
}

function getActiveAcks(acks) {
    const now = new Date();
    return acks.filter(a => !a.expires_at || new Date(a.expires_at) >= now);
}

function main() {
    const args = parseArgs(process.argv);
    const data = loadAcknowledgments();

    // List mode
    if (args.list) {
        console.log('\nSHERLOG ACKNOWLEDGMENTS\n');

        const active = getActiveAcks(data.acknowledgments);
        const expired = getExpiredAcks(data.acknowledgments);

        if (active.length === 0 && expired.length === 0) {
            console.log('No acknowledgments recorded.');
            return;
        }

        if (active.length > 0) {
            console.log('ACTIVE:');
            active.forEach(a => {
                const expiry = a.expires_at ? `expires ${a.expires_at.split('T')[0]}` : 'no expiry';
                console.log(`  • ${a.gap_type} — "${a.reason}" (${expiry})`);
            });
        }

        if (expired.length > 0) {
            console.log('\nEXPIRED (re-escalated to gaps):');
            expired.forEach(a => {
                console.log(`  ⚠ ${a.gap_type} — "${a.reason}" (expired ${a.expires_at.split('T')[0]})`);
            });
        }

        return;
    }

    // Clear expired mode
    if (args['clear-expired']) {
        const before = data.acknowledgments.length;
        data.acknowledgments = getActiveAcks(data.acknowledgments);
        const removed = before - data.acknowledgments.length;
        saveAcknowledgments(data);
        console.log(`Cleared ${removed} expired acknowledgment(s).`);
        return;
    }

    // Add acknowledgment mode
    if (!args.gap || !args.reason) {
        console.log('Usage: sherlog:ack --gap="gap_type" --reason="Why deferred" [--expiry="30d"]');
        console.log('       sherlog:ack --list');
        console.log('       sherlog:ack --clear-expired');
        process.exit(1);
    }

    const ack = {
        gap_type: args.gap,
        reason: args.reason,
        acknowledged_at: new Date().toISOString(),
        expires_at: parseExpiry(args.expiry),
        acknowledged_by: process.env.USER || 'unknown'
    };

    data.acknowledgments.push(ack);
    saveAcknowledgments(data);

    console.log(`\n✓ Acknowledged: ${ack.gap_type}`);
    console.log(`  Reason: ${ack.reason}`);
    console.log(`  Expires: ${ack.expires_at ? ack.expires_at.split('T')[0] : 'never'}`);
    console.log(`\nThis deferral is now tracked in: ${ACK_FILE}`);
}

main();

#!/usr/bin/env python3
"""
Import Google Contacts CSV export into Terminus's people table.

Usage:
    python3 scripts/import-google-contacts.py contacts.csv [--db PATH] [--scope SCOPE] [--dry-run]

The relationship field is left empty so Terminus can fill it in as it learns
about each contact.
"""

import argparse
import csv
import os
import re
import sqlite3
import sys
from urllib.parse import unquote

DEFAULT_DB = os.path.join(os.path.dirname(__file__), '..', 'sapphire-data', 'knowledge.db')
PHONE_RE = re.compile(r'^[\+\d\s\(\)\-\.x]+$')


def resolve_name(row):
    first = row.get('First Name', '').strip()
    last = row.get('Last Name', '').strip()
    full = ' '.join(p for p in (first, last) if p)
    if full:
        return full
    org = row.get('Organization Name', '').strip()
    if org:
        return org
    return ''


def clean_phone(raw):
    """URL-decode and strip trailing punctuation from phone strings."""
    val = unquote(raw).strip().rstrip(',').strip()
    # Sapphire stores "::: " separated multi-values; take just the first
    val = val.split(':::')[0].strip()
    return val


def collect_phones(row):
    phones = []
    for i in range(1, 4):
        label_key = f'Phone {i} - Label'
        val_key = f'Phone {i} - Value'
        val = row.get(val_key, '').strip()
        if not val:
            break
        cleaned = clean_phone(val)
        if cleaned:
            phones.append(cleaned)
    return phones


def collect_emails(row):
    emails = []
    for i in range(1, 4):
        val = row.get(f'E-mail {i} - Value', '').strip()
        if not val:
            break
        emails.append(val)
    return emails


def build_notes(row, extra_phones, extra_emails):
    parts = []
    org = row.get('Organization Name', '').strip()
    title = row.get('Organization Title', '').strip()
    raw_notes = row.get('Notes', '').strip()
    birthday = row.get('Birthday', '').strip()

    if title:
        parts.append(title)
    if org:
        parts.append(org)
    if raw_notes:
        parts.append(raw_notes)
    if birthday:
        parts.append(f'Birthday: {birthday}')
    if extra_phones:
        parts.append('Other phones: ' + ', '.join(extra_phones))
    if extra_emails:
        parts.append('Other emails: ' + ', '.join(extra_emails))

    return '. '.join(parts)


def import_csv(csv_path, db_path, scope, dry_run):
    with open(csv_path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    if not rows:
        print('No rows found in CSV.')
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Load existing entries for dedup (name + email, case-insensitive)
    existing = cur.execute(
        'SELECT name, email FROM people WHERE scope = ?', (scope,)
    ).fetchall()
    existing_keys = {
        (r['name'].lower().strip(), (r['email'] or '').lower().strip())
        for r in existing
    }

    imported = skipped = malformed = 0

    for row in rows:
        name = resolve_name(row)
        if not name:
            malformed += 1
            continue

        phones = collect_phones(row)
        emails = collect_emails(row)

        phone = phones[0] if phones else ''
        email = emails[0] if emails else ''
        address = row.get('Address 1 - Formatted', '').strip()
        notes = build_notes(row, phones[1:], emails[1:])

        dup_key = (name.lower(), email.lower())
        if dup_key in existing_keys:
            skipped += 1
            continue

        if dry_run:
            print(f'  [dry-run] Would import: {name!r}  phone={phone!r}  email={email!r}')
        else:
            cur.execute(
                '''INSERT INTO people (name, relationship, phone, email, address, notes, scope)
                   VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (name, '', phone, email, address, notes, scope)
            )

        existing_keys.add(dup_key)
        imported += 1

    if not dry_run:
        conn.commit()
    conn.close()

    print(f'Done. imported={imported}  skipped(duplicates)={skipped}  malformed(no name)={malformed}')
    if dry_run:
        print('(dry-run — nothing was written)')


def main():
    parser = argparse.ArgumentParser(description='Import Google Contacts CSV into Terminus')
    parser.add_argument('csv', help='Path to Google Contacts CSV export')
    parser.add_argument('--db', default=DEFAULT_DB, help='Path to knowledge.db')
    parser.add_argument('--scope', default='default', help='Scope to import into (default: default)')
    parser.add_argument('--dry-run', action='store_true', help='Preview without writing')
    args = parser.parse_args()

    db_path = os.path.realpath(args.db)
    if not os.path.exists(db_path):
        print(f'Error: database not found at {db_path}', file=sys.stderr)
        sys.exit(1)

    csv_path = os.path.realpath(args.csv)
    if not os.path.exists(csv_path):
        print(f'Error: CSV file not found at {csv_path}', file=sys.stderr)
        sys.exit(1)

    import_csv(csv_path, db_path, args.scope, args.dry_run)


if __name__ == '__main__':
    main()

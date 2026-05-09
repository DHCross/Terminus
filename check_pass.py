import bcrypt
import sys

passwords = ["terminus", "sapphire", "password", "admin", "123456", "dancross"]
hash_val = "b.a772vfFfY4AOS1lHvkVYX.K"

found = False
hash_bytes = hash_val.encode('utf-8')
for p in passwords:
    if bcrypt.checkpw(p.encode('utf-8'), hash_bytes):
        print(f"FOUND: {p}")
        found = True
        break

if not found:
    print("No common passwords matched.")
